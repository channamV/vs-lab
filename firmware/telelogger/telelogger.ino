/******************************************************************************
* Arduino sketch of a vehicle data data logger and telemeter for Freematics Hub
* Works with Freematics ONE+ Model A and Model B
* Developed by Stanley Huang <stanley@freematics.com.au>
* Distributed under BSD license
* Visit https://freematics.com/products for hardware information
* Visit https://hub.freematics.com to view live and history telemetry data
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
* THE SOFTWARE.
******************************************************************************/

#include "mbedtls/md.h" // VSLAB: HMAC for device commands
#include <FreematicsPlus.h>
#include <httpd.h>
#include "config.h"
#include "telestore.h"
#include "teleclient.h"

#ifdef VSLAB_TEST_PING_SECONDS
// VSLAB test build: parked check-ins every few seconds instead of every 15 minutes
#undef PING_BACK_INTERVAL
#define PING_BACK_INTERVAL VSLAB_TEST_PING_SECONDS
#endif
#if BOARD_HAS_PSRAM
#include "esp32/himem.h"
#endif
#include "driver/adc.h"
#include "nvs_flash.h"
#include "nvs.h"
#if ENABLE_OLED
#include "FreematicsOLED.h"
#endif

// states
#define STATE_STORAGE_READY 0x1
#define STATE_OBD_READY 0x2
#define STATE_GPS_READY 0x4
#define STATE_MEMS_READY 0x8
#define STATE_NET_READY 0x10
#define STATE_GPS_ONLINE 0x20
#define STATE_CELL_CONNECTED 0x40
#define STATE_WIFI_CONNECTED 0x80
#define STATE_WORKING 0x100
#define STATE_STANDBY 0x200

typedef struct {
  byte pid;
  byte tier;
  int value;
  uint32_t ts;
} PID_POLLING_INFO;

PID_POLLING_INFO obdData[]= {
  {PID_SPEED, 1},
  {PID_RPM, 1},
  {PID_THROTTLE, 1},
  {PID_ENGINE_LOAD, 1},
  {PID_FUEL_PRESSURE, 2},
  {PID_TIMING_ADVANCE, 2},
  {PID_COOLANT_TEMP, 3},
  {PID_INTAKE_TEMP, 3},
};

CBufferManager bufman;
Task subtask;

#if ENABLE_MEMS
float accBias[3] = {0}; // calibrated reference accelerometer data
float accSum[3] = {0};
float acc[3] = {0};
float gyr[3] = {0};
float mag[3] = {0};
uint8_t accCount = 0;
#endif
int deviceTemp = 0;

// config data
char apn[32];
#if ENABLE_WIFI
char wifiSSID[32] = WIFI_SSID;
char wifiPassword[32] = WIFI_PASSWORD;
#endif
nvs_handle_t nvs;

// live data
String netop;
String ip;
int16_t rssi = 0;
int16_t rssiLast = 0;
char vin[18] = {0};
uint16_t dtc[6] = {0};
float batteryVoltage = 0;
GPS_DATA* gd = 0;

char devid[12] = {0};
char isoTime[32] = {0};

// stats data
uint32_t lastMotionTime = 0;
// VSLAB: why the device last stopped working (sent with the logout as &WHY=) and why it last restarted (&RST= on login)
const char* standbyReason = "";
char bootInfo[24] = "";
char logoutInfo[32] = "";
uint32_t timeoutsOBD = 0;
uint32_t timeoutsNet = 0;
// VSLAB: set by the network task once it has handled going to sleep (unsent readings saved), see standby()
volatile bool netParked = false;
// VSLAB: the SD card is mounted (it stays mounted while the device sleeps; STATE_STORAGE_READY doesn't)
bool sdMounted = false;
uint32_t lastStatsTime = 0;

int32_t syncInterval = SERVER_SYNC_INTERVAL * 1000;
int32_t dataInterval = 1000;

#if STORAGE != STORAGE_NONE
int fileid = 0;
uint16_t lastSizeKB = 0;
#endif

byte ledMode = 0;

bool serverSetup(IPAddress& ip);
void serverProcess(int timeout);
void processMEMS(CBuffer* buffer);
bool processGPS(CBuffer* buffer);
void processBLE(int timeout);

class State {
public:
  bool check(uint16_t flags) { return (m_state & flags) == flags; }
  void set(uint16_t flags) { m_state |= flags; }
  void clear(uint16_t flags) { m_state &= ~flags; }
  uint16_t m_state = 0;
};

FreematicsESP32 sys;

class OBD : public COBD
{
protected:
  void idleTasks()
  {
    // do some quick tasks while waiting for OBD response
#if ENABLE_MEMS
    processMEMS(0);
#endif
    processBLE(0);
  }
};

OBD obd;

MEMS_I2C* mems = 0;

#if STORAGE == STORAGE_SPIFFS
SPIFFSLogger logger;
#elif STORAGE == STORAGE_SD
SDLogger logger;
#endif

#if SERVER_PROTOCOL == PROTOCOL_UDP
TeleClientUDP teleClient;
#else
TeleClientHTTP teleClient;
#endif

#if ENABLE_OLED
OLED_SH1106 oled;
#endif

State state;

void printTimeoutStats()
{
  Serial.print("Timeouts: OBD:");
  Serial.print(timeoutsOBD);
  Serial.print(" Network:");
  Serial.println(timeoutsNet);
}

void beep(int duration)
{
    // turn on buzzer at 2000Hz frequency 
    sys.buzzer(2000);
    delay(duration);
    // turn off buzzer
    sys.buzzer(0);
}

/*******************************************************************************
  VSLAB: operator alerts (docs/operator-alerts.md). VS-lab sends ALERT=not_checked_in / checklist_due / none as a
  device command; while the engine runs the pattern repeats every 30 s. BEEP=<n> sounds the buzzer n times.
  Set by the network task (runCommands), played by the data loop (playAlerts).
*******************************************************************************/
enum { ALERT_NONE, ALERT_NOT_CHECKED_IN, ALERT_CHECKLIST_DUE };
volatile uint8_t alertKind = ALERT_NONE;
volatile uint8_t beepRequest = 0;
uint32_t lastAlertBeep = 0;

// Is the engine running, as far as the device can tell? Without RPM or machine power, trust VS-lab (it only asks
// while it sees the engine running).
bool engineRunning()
{
#if ENABLE_OBD
  // OBD builds are for vehicles with an engine computer: no answer means the ignition is off. Voltage isn't used:
  // it stays high for minutes after a drive (field test 2026-10-26: beeps with the engine off at 14.4 V).
  if (!state.check(STATE_OBD_READY)) return false;
  for (byte i = 0; i < sizeof(obdData) / sizeof(obdData[0]); i++) {
    if (obdData[i].pid == PID_RPM) return obdData[i].value >= 300;
  }
  return false;
#else
  if (batteryVoltage >= 8) return batteryVoltage >= (batteryVoltage > 18 ? 26.4f : 13.2f);
  return true;
#endif
}

void playAlerts()
{
  if (beepRequest) {
    for (byte i = 0; i < beepRequest; i++) {
      beep(150);
      delay(150);
    }
    beepRequest = 0;
  }
  if (alertKind == ALERT_NONE || !engineRunning()) return;
  if (lastAlertBeep && millis() - lastAlertBeep < 30000) return;
  if (alertKind == ALERT_NOT_CHECKED_IN) {
    // two long beeps
    beep(700);
    delay(300);
    beep(700);
  } else {
    // three short beeps
    for (byte i = 0; i < 3; i++) {
      beep(150);
      if (i < 2) delay(150);
    }
  }
  lastAlertBeep = millis();
}

#if LOG_EXT_SENSORS
void processExtInputs(CBuffer* buffer)
{
#if LOG_EXT_SENSORS == 1
  uint8_t levels[2] = {(uint8_t)digitalRead(PIN_SENSOR1), (uint8_t)digitalRead(PIN_SENSOR2)};
  buffer->add(PID_EXT_SENSORS, ELEMENT_UINT8, levels, sizeof(levels), 2);
#elif LOG_EXT_SENSORS == 2
  uint16_t reading[] = {adc1_get_raw(ADC1_CHANNEL_0), adc1_get_raw(ADC1_CHANNEL_1)};
  Serial.print("GPIO0:");
  Serial.print((float)reading[0] * 3.15 / 4095 - 0.01);
  Serial.print(" GPIO1:");
  Serial.println((float)reading[1] * 3.15 / 4095 - 0.01);
  buffer->add(PID_EXT_SENSORS, ELEMENT_UINT16, reading, sizeof(reading), 2);
#endif
}
#endif

/*******************************************************************************
  HTTP API
*******************************************************************************/
#if ENABLE_HTTPD
int handlerLiveData(UrlHandlerParam* param)
{
    char *buf = param->pucBuffer;
    int bufsize = param->bufSize;
    int n = snprintf(buf, bufsize, "{\"obd\":{\"vin\":\"%s\",\"battery\":%.1f,\"pid\":[", vin, batteryVoltage);
    uint32_t t = millis();
    for (int i = 0; i < sizeof(obdData) / sizeof(obdData[0]); i++) {
        n += snprintf(buf + n, bufsize - n, "{\"pid\":%u,\"value\":%d,\"age\":%u},",
            0x100 | obdData[i].pid, obdData[i].value, (unsigned int)(t - obdData[i].ts));
    }
    n--;
    n += snprintf(buf + n, bufsize - n, "]}");
#if ENABLE_MEMS
    if (accCount) {
      n += snprintf(buf + n, bufsize - n, ",\"mems\":{\"acc\":[%d,%d,%d],\"stationary\":%u}",
          (int)((accSum[0] / accCount - accBias[0]) * 100), (int)((accSum[1] / accCount - accBias[1]) * 100), (int)((accSum[2] / accCount - accBias[2]) * 100),
          (unsigned int)(millis() - lastMotionTime));
    }
#endif
    if (gd && gd->ts) {
      n += snprintf(buf + n, bufsize - n, ",\"gps\":{\"utc\":\"%s\",\"lat\":%f,\"lng\":%f,\"alt\":%f,\"speed\":%f,\"sat\":%d,\"age\":%u}",
          isoTime, gd->lat, gd->lng, gd->alt, gd->speed, (int)gd->sat, (unsigned int)(millis() - gd->ts));
    }
    buf[n++] = '}';
    param->contentLength = n;
    param->contentType=HTTPFILETYPE_JSON;
    return FLAG_DATA_RAW;
}
#endif

/*******************************************************************************
  Reading and processing OBD data
*******************************************************************************/
#if ENABLE_OBD
void processOBD(CBuffer* buffer)
{
  static int idx[2] = {0, 0};
  int tier = 1;
  for (byte i = 0; i < sizeof(obdData) / sizeof(obdData[0]); i++) {
    if (obdData[i].tier > tier) {
        // reset previous tier index
        idx[tier - 2] = 0;
        // keep new tier number
        tier = obdData[i].tier;
        // move up current tier index
        i += idx[tier - 2]++;
        // check if into next tier
        if (obdData[i].tier != tier) {
            idx[tier - 2]= 0;
            i--;
            continue;
        }
    }
    byte pid = obdData[i].pid;
    if (!obd.isValidPID(pid)) continue;
    int value;
    if (obd.readPID(pid, value)) {
        obdData[i].ts = millis();
        obdData[i].value = value;
        buffer->add((uint16_t)pid | 0x100, ELEMENT_INT32, &value, sizeof(value));
    } else {
        timeoutsOBD++;
        printTimeoutStats();
        break;
    }
    if (tier > 1) break;
  }
  int kph = obdData[0].value;
  if (kph >= 2) lastMotionTime = millis();
}
#endif

bool initGPS()
{
  // start GNSS receiver
  if (sys.gpsBeginExt()) {
    Serial.println("GNSS:OK(E)");
  } else if (sys.gpsBegin()) {
    Serial.println("GNSS:OK(I)");
  } else {
    Serial.println("GNSS:NO");
    return false;
  }
  return true;
}

bool processGPS(CBuffer* buffer)
{
  static uint32_t lastGPStime = 0;
  static float lastGPSLat = 0;
  static float lastGPSLng = 0;

  if (!gd) {
    lastGPStime = 0;
    lastGPSLat = 0;
    lastGPSLng = 0;
  }
#if GNSS == GNSS_STANDALONE
  if (state.check(STATE_GPS_READY)) {
    // read parsed GPS data
    if (!sys.gpsGetData(&gd)) {
      return false;
    }
  }
#else
    if (!teleClient.cell.getLocation(&gd)) {
      return false;
    }
#endif
  if (!gd || lastGPStime == gd->time) return false;
  if (gd->date) {
    // generate ISO time string
    char *p = isoTime + sprintf(isoTime, "%04u-%02u-%02uT%02u:%02u:%02u",
        (unsigned int)(gd->date % 100) + 2000, (unsigned int)(gd->date / 100) % 100, (unsigned int)(gd->date / 10000),
        (unsigned int)(gd->time / 1000000), (unsigned int)(gd->time % 1000000) / 10000, (unsigned int)(gd->time % 10000) / 100);
    unsigned char tenth = (gd->time % 100) / 10;
    if (tenth) p += sprintf(p, ".%c00", '0' + tenth);
    *p = 'Z';
    *(p + 1) = 0;
  }
  if (gd->lng == 0 && gd->lat == 0) {
    // coordinates not ready
    if (gd->date) {
      Serial.print("[GNSS] ");
      Serial.println(isoTime);
    }
    return false;
  }
  if ((lastGPSLat || lastGPSLng) && (abs(gd->lat - lastGPSLat) > 0.001 || abs(gd->lng - lastGPSLng) > 0.001)) {
    // invalid coordinates data
    lastGPSLat = 0;
    lastGPSLng = 0;
    return false;
  }
  lastGPSLat = gd->lat;
  lastGPSLng = gd->lng;

  float kph = gd->speed * 1.852f;
  if (kph >= 2) lastMotionTime = millis();

  if (buffer) {
    buffer->add(PID_GPS_TIME, ELEMENT_UINT32, &gd->time, sizeof(uint32_t));
    // VSLAB: the GPS date too (DDMMYY, e.g. 251026), so VS-lab doesn't have to infer it from the arrival time
    if (gd->date) buffer->add(PID_GPS_DATE, ELEMENT_UINT32, &gd->date, sizeof(uint32_t));
    buffer->add(PID_GPS_LATITUDE, ELEMENT_FLOAT, &gd->lat, sizeof(float));
    buffer->add(PID_GPS_LONGITUDE, ELEMENT_FLOAT, &gd->lng, sizeof(float));
    buffer->add(PID_GPS_ALTITUDE, ELEMENT_FLOAT_D1, &gd->alt, sizeof(float)); /* m */
    buffer->add(PID_GPS_SPEED, ELEMENT_FLOAT_D1, &kph, sizeof(kph));
    buffer->add(PID_GPS_HEADING, ELEMENT_UINT16, &gd->heading, sizeof(uint16_t));
    if (gd->sat) buffer->add(PID_GPS_SAT_COUNT, ELEMENT_UINT8, &gd->sat, sizeof(uint8_t));
    if (gd->hdop) buffer->add(PID_GPS_HDOP, ELEMENT_UINT8, &gd->hdop, sizeof(uint8_t));
  }
  
  Serial.print("[GNSS] ");
  Serial.print(gd->lat, 6);
  Serial.print(' ');
  Serial.print(gd->lng, 6);
  Serial.print(' ');
  Serial.print((int)kph);
  Serial.print("km/h");
  Serial.print(" SATS:");
  Serial.print(gd->sat);
  Serial.print(" HDOP:");
  Serial.print(gd->hdop);
  Serial.print(" Course:");
  Serial.println(gd->heading);
  //Serial.println(gd->errors);
  lastGPStime = gd->time;
  return true;
}

bool waitMotionGPS(int timeout)
{
  unsigned long t = millis();
  lastMotionTime = 0;
  do {
      serverProcess(100);
    if (!processGPS(0)) continue;
    if (lastMotionTime) return true;
  } while (millis() - t < timeout);
  return false;
}

#if ENABLE_MEMS
void processMEMS(CBuffer* buffer)
{
  if (!state.check(STATE_MEMS_READY)) return;

  // load and store accelerometer data
  float temp;
#if ENABLE_ORIENTATION
  ORIENTATION ori;
  if (!mems->read(acc, gyr, mag, &temp, &ori)) return;
#else
  if (!mems->read(acc, gyr, mag, &temp)) return;
#endif
  deviceTemp = (int)temp;

  accSum[0] += acc[0];
  accSum[1] += acc[1];
  accSum[2] += acc[2];
  accCount++;

  if (buffer) {
    if (accCount) {
      float value[3];
      value[0] = accSum[0] / accCount - accBias[0];
      value[1] = accSum[1] / accCount - accBias[1];
      value[2] = accSum[2] / accCount - accBias[2];
      buffer->add(PID_ACC, ELEMENT_FLOAT_D2, value, sizeof(value), 3);
/*
      Serial.print("[ACC] ");
      Serial.print(value[0]);
      Serial.print('/');
      Serial.print(value[1]);
      Serial.print('/');
      Serial.println(value[2]);
*/
#if ENABLE_ORIENTATION
      value[0] = ori.yaw;
      value[1] = ori.pitch;
      value[2] = ori.roll;
      buffer->add(PID_ORIENTATION, ELEMENT_FLOAT_D2, value, sizeof(value), 3);
#endif
#if 0
      // calculate motion
      float motion = 0;
      for (byte i = 0; i < 3; i++) {
        motion += value[i] * value[i];
      }
      if (motion >= MOTION_THRESHOLD * MOTION_THRESHOLD) {
        lastMotionTime = millis();
        Serial.print("Motion:");
        Serial.println(motion);
      }
#endif
    }
    accSum[0] = 0;
    accSum[1] = 0;
    accSum[2] = 0;
    accCount = 0;
  }
}

void calibrateMEMS()
{
  if (state.check(STATE_MEMS_READY)) {
    accBias[0] = 0;
    accBias[1] = 0;
    accBias[2] = 0;
    int n;
    unsigned long t = millis();
    for (n = 0; millis() - t < 1000; n++) {
      float acc[3];
      if (!mems->read(acc)) continue;
      accBias[0] += acc[0];
      accBias[1] += acc[1];
      accBias[2] += acc[2];
      delay(10);
    }
    accBias[0] /= n;
    accBias[1] /= n;
    accBias[2] /= n;
    Serial.print("ACC BIAS:");
    Serial.print(accBias[0]);
    Serial.print('/');
    Serial.print(accBias[1]);
    Serial.print('/');
    Serial.println(accBias[2]);
  }
}
#endif

void printTime()
{
  time_t utc;
  time(&utc);
  struct tm *btm = gmtime(&utc);
  if (btm->tm_year > 100) {
    // valid system time available
    char buf[64];
    sprintf(buf, "%04u-%02u-%02u %02u:%02u:%02u",
      1900 + btm->tm_year, btm->tm_mon + 1, btm->tm_mday, btm->tm_hour, btm->tm_min, btm->tm_sec);
    Serial.print("UTC:");
    Serial.println(buf);
  }
}

/*******************************************************************************
  Initializing all data logging components
*******************************************************************************/
void initialize()
{
  // dump buffer data
  bufman.purge();

#if ENABLE_MEMS
  if (state.check(STATE_MEMS_READY)) {
    calibrateMEMS();
  }
#endif

#if GNSS == GNSS_STANDALONE
  if (!state.check(STATE_GPS_READY)) {
    if (initGPS()) {
      state.set(STATE_GPS_READY);
    }
  }
#endif

#if ENABLE_OBD
  // initialize OBD communication
  if (!state.check(STATE_OBD_READY)) {
    timeoutsOBD = 0;
    if (obd.init()) {
      Serial.println("OBD:OK");
      state.set(STATE_OBD_READY);
#if ENABLE_OLED
      oled.println("OBD OK");
#endif
    } else {
      Serial.println("OBD:NO");
      //state.clear(STATE_WORKING);
      //return;
    }
  }
#endif

#if STORAGE != STORAGE_NONE
  if (!state.check(STATE_STORAGE_READY)) {
    // init storage
    if (logger.init()) {
      state.set(STATE_STORAGE_READY);
      sdMounted = true; // VSLAB
    }
  }
  if (state.check(STATE_STORAGE_READY)) {
    fileid = logger.begin();
  }
#endif

  // re-try OBD if connection not established
#if ENABLE_OBD
  if (state.check(STATE_OBD_READY)) {
    char buf[128];
    if (obd.getVIN(buf, sizeof(buf))) {
      memcpy(vin, buf, sizeof(vin) - 1);
      Serial.print("VIN:");
      Serial.println(vin);
    }
    int dtcCount = obd.readDTC(dtc, sizeof(dtc) / sizeof(dtc[0]));
    if (dtcCount > 0) {
      Serial.print("DTC:");
      Serial.println(dtcCount);
    }
#if ENABLE_OLED
    oled.print("VIN:");
    oled.println(vin);
#endif
  }
#endif

  // check system time
  printTime();

  lastMotionTime = millis();
  state.set(STATE_WORKING);

#if ENABLE_OLED
  delay(1000);
  oled.clear();
  oled.print("DEVICE ID: ");
  oled.println(devid);
  oled.setCursor(0, 7);
  oled.print("Packets");
  oled.setCursor(80, 7);
  oled.print("KB Sent");
  oled.setFontSize(FONT_SIZE_MEDIUM);
#endif
}

void showStats()
{
  uint32_t t = millis() - teleClient.startTime;
  char buf[32];
  sprintf(buf, "%02u:%02u.%c ", t / 60000, (t % 60000) / 1000, (t % 1000) / 100 + '0');
  Serial.print("[NET] ");
  Serial.print(buf);
  Serial.print("| Packet #");
  Serial.print(teleClient.txCount);
  Serial.print(" | Out: ");
  Serial.print(teleClient.txBytes >> 10);
  Serial.print(" KB | In: ");
  Serial.print(teleClient.rxBytes);
  Serial.print(" bytes | ");
  Serial.print((unsigned int)((uint64_t)(teleClient.txBytes + teleClient.rxBytes) * 3600 / (millis() - teleClient.startTime)));
  Serial.print(" KB/h");

  Serial.println();
#if ENABLE_OLED
  oled.setCursor(0, 2);
  oled.println(timestr);
  oled.setCursor(0, 5);
  oled.printInt(teleClient.txCount, 2);
  oled.setCursor(80, 5);
  oled.printInt(teleClient.txBytes >> 10, 3);
#endif
}

bool waitMotion(long timeout)
{
#if ENABLE_MEMS
  unsigned long t = millis();
  if (state.check(STATE_MEMS_READY)) {
    do {
      // calculate relative movement
      float motion = 0;
      float acc[3];
      if (!mems->read(acc)) continue;
      if (accCount == 10) {
        accCount = 0;
        accSum[0] = 0;
        accSum[1] = 0;
        accSum[2] = 0;
      }
      accSum[0] += acc[0];
      accSum[1] += acc[1];
      accSum[2] += acc[2];
      accCount++;
      for (byte i = 0; i < 3; i++) {
        float m = (acc[i] - accBias[i]);
        motion += m * m;
      }
#if ENABLE_HTTPD
      serverProcess(100);
#endif
      processBLE(100);
      // check movement
      if (motion >= MOTION_THRESHOLD * MOTION_THRESHOLD) {
        //lastMotionTime = millis();
        Serial.println(motion);
        return true;
      }
    } while (state.check(STATE_STANDBY) && ((long)(millis() - t) < timeout || timeout == -1));
    return false;
  }
#endif
  serverProcess(timeout);
  return false;
}

/*******************************************************************************
  Collecting and processing data
*******************************************************************************/
// VSLAB: supply voltage (PID 0x24), moved out of process() so the final "engine off" reading can include it
// VSLAB: the supply voltage (0 = can't read it), for the data loop and the parked check-ins
float readSupplyVolts()
{
#if ENABLE_OBD
  if (sys.devType > 12) return (float)(analogRead(A0) * 45) / 4095;
  return obd.getVoltage();
#else
  // VSLAB: board type 15 (Model H) reads its supply voltage on the ESP32's A0 pin, as the OBD build does,
  // so send it without OBD too: no engine computer needed. (Upstream uses A0 for every board type above 12;
  // only 15 is checked.) Other boards read it through the OBD co-processor.
  if (sys.devType == 15) return (float)(analogRead(A0) * 45) / 4095;
  return 0;
#endif
}

void addSupplyVoltage(CBuffer* buffer)
{
  batteryVoltage = readSupplyVolts();
  if (batteryVoltage) {
    uint16_t v = batteryVoltage * 100;
    buffer->add(PID_BATTERY_VOLTAGE, ELEMENT_UINT16, &v, sizeof(v));
  }
}

void process()
{
  static uint32_t lastGPStick = 0;
  uint32_t startTime = millis();

  CBuffer* buffer = bufman.getFree();
  buffer->state = BUFFER_STATE_FILLING;

#if ENABLE_OBD
  // process OBD data if connected
  if (state.check(STATE_OBD_READY)) {
    processOBD(buffer);
    if (obd.errors >= MAX_OBD_ERRORS) {
      if (!obd.init()) {
        if (millis() - lastMotionTime < 30000) {
          // VSLAB: the engine computer can drop out for a moment while driving (field test 2026-10-26: the device
          // went quiet mid-drive). Don't go to sleep while GPS or motion says it moved in the last 30 s: keep
          // tracking and keep trying OBD.
          Serial.println("[OBD] ECU not answering, but moving: keep working");
          state.clear(STATE_OBD_READY);
        } else {
          Serial.println("[OBD] ECU OFF");
          standbyReason = "ecu_off"; // VSLAB
          state.clear(STATE_OBD_READY | STATE_WORKING);
          // VSLAB: finish this reading as an explicit "engine off" (RPM 0, OBD PID 0x0C, with voltage and position)
          // instead of abandoning it, so it's sent before signing off and VS-lab sees the stop
          int32_t rpm = 0;
          buffer->add(0x100 | 0x0C, ELEMENT_INT32, &rpm, sizeof(rpm));
          addSupplyVoltage(buffer);
          processGPS(buffer);
          buffer->add(PID_DEVICE_TEMP, ELEMENT_INT32, &deviceTemp, sizeof(deviceTemp));
          buffer->timestamp = millis();
          buffer->state = BUFFER_STATE_FILLED;
          return;
        }
      }
    }
  } else if (obd.init(PROTO_AUTO, true)) {
    state.set(STATE_OBD_READY);
    Serial.println("[OBD] ECU ON");
  }
#endif

  if (rssi != rssiLast) {
    int val = (rssiLast = rssi);
    buffer->add(PID_CSQ, ELEMENT_INT32, &val, sizeof(val));
  }
  addSupplyVoltage(buffer);

#if LOG_EXT_SENSORS
  processExtInputs(buffer);
#endif

#if ENABLE_MEMS
  processMEMS(buffer);
#endif

  bool success = processGPS(buffer);
#if GNSS_RESET_TIMEOUT
  if (success) {
    lastGPStick = millis();
    state.set(STATE_GPS_ONLINE);
  } else {
    if (millis() - lastGPStick > GNSS_RESET_TIMEOUT * 1000) {
      sys.gpsEnd();
      state.clear(STATE_GPS_ONLINE | STATE_GPS_READY);
      delay(20);
      if (initGPS()) state.set(STATE_GPS_READY);
      lastGPStick = millis();
    }
  }
#endif

  if (!state.check(STATE_MEMS_READY)) {
    deviceTemp = readChipTemperature();
  }
  buffer->add(PID_DEVICE_TEMP, ELEMENT_INT32, &deviceTemp, sizeof(deviceTemp));

  buffer->timestamp = millis();
  buffer->state = BUFFER_STATE_FILLED;

  // display file buffer stats
  if (startTime - lastStatsTime >= 3000) {
    bufman.printStats();
    lastStatsTime = startTime;
  }

#if STORAGE != STORAGE_NONE
  if (state.check(STATE_STORAGE_READY)) {
    buffer->serialize(logger);
    uint16_t sizeKB = (uint16_t)(logger.size() >> 10);
    if (sizeKB != lastSizeKB) {
      logger.flush();
      lastSizeKB = sizeKB;
      Serial.print("[FILE] ");
      Serial.print(sizeKB);
      Serial.println("KB");
    }
  }
#endif

  const int dataIntervals[] = DATA_INTERVAL_TABLE;
#if ENABLE_OBD || ENABLE_MEMS
  // motion adaptive data interval control
  const uint16_t stationaryTime[] = STATIONARY_TIME_TABLE;
  unsigned int motionless = (millis() - lastMotionTime) / 1000;
  bool stationary = true;
  for (byte i = 0; i < sizeof(stationaryTime) / sizeof(stationaryTime[0]); i++) {
    dataInterval = dataIntervals[i];
    if (motionless < stationaryTime[i] || stationaryTime[i] == 0) {
      stationary = false;
      break;
    }
  }
#ifdef VSLAB_CELL_DEBUG
  stationary = false; // VSLAB test build: never go to standby on the desk
#endif
#if ENABLE_OBD
  // VSLAB: an idling machine is in use: no sleep while the engine computer reports the engine running (field test
  // 2026-10-27: the device slept 3 minutes after parking with the engine idling, so VS-lab saw the engine stop)
  static bool idleNoted = false;
  if (stationary && engineRunning()) {
    if (!idleNoted) Serial.println("[OBD] Not moving, engine running: staying awake");
    idleNoted = true;
    stationary = false;
  } else if (!stationary) {
    idleNoted = false;
  }
#endif
  if (stationary) {
    // stationery timeout
    Serial.print("Stationary for ");
    Serial.print(motionless);
    Serial.println(" secs");
    // trip ended, go into standby
    standbyReason = "stationary"; // VSLAB
    state.clear(STATE_WORKING);
    return;
  }
#else
  dataInterval = dataIntervals[0];
#endif
  playAlerts(); // VSLAB: operator alerts and BEEP commands

  do {
    long t = dataInterval - (millis() - startTime);
    processBLE(t > 0 ? t : 0);
  } while (millis() - startTime < dataInterval);
}

bool initCell(bool quick = false)
{
  Serial.println("[CELL] Activating...");
  // power on network module
  if (!teleClient.cell.begin(&sys)) {
    Serial.println("[CELL] No supported module");
#if ENABLE_OLED
    oled.println("No Cell Module");
#endif
    return false;
  }
  if (quick) return true;
#if ENABLE_OLED
    oled.print(teleClient.cell.deviceName());
    oled.println(" OK\r");
    oled.print("IMEI:");
    oled.println(teleClient.cell.IMEI);
#endif
  Serial.print("CELL:");
  Serial.println(teleClient.cell.deviceName());
  if (!teleClient.cell.checkSIM(SIM_CARD_PIN)) {
    Serial.println("NO SIM CARD");
    //return false;
  }
  Serial.print("IMEI:");
  Serial.println(teleClient.cell.IMEI);
  Serial.println("[CELL] Searching...");
  if (*apn) {
    Serial.print("APN:");
    Serial.println(apn);
  }
#ifdef VSLAB_CELL_DEBUG
  // VSLAB test build: give the first network registration 3 minutes instead of 30 seconds
  if (teleClient.cell.setup(apn, APN_USERNAME, APN_PASSWORD, 180000)) {
#else
  if (teleClient.cell.setup(apn, APN_USERNAME, APN_PASSWORD)) {
#endif
    netop = teleClient.cell.getOperatorName();
    if (netop.length()) {
      Serial.print("Operator:");
      Serial.println(netop);
#if ENABLE_OLED
      oled.println(op);
#endif
    }

#if GNSS == GNSS_CELLULAR
    if (teleClient.cell.setGPS(true)) {
      Serial.println("CELL GNSS:OK");
    }
#endif

    ip = teleClient.cell.getIP();
    if (ip.length()) {
      Serial.print("[CELL] IP:");
      Serial.println(ip);
#if ENABLE_OLED
      oled.print("IP:");
      oled.println(ip);
#endif
    }
    state.set(STATE_CELL_CONNECTED);
  } else {
    char *p = strstr(teleClient.cell.getBuffer(), "+CPSI:");
    if (p) {
      char *q = strchr(p, '\r');
      if (q) *q = 0;
      Serial.print("[CELL] ");
      Serial.println(p + 7);
#if ENABLE_OLED
      oled.println(p + 7);
#endif
    } else {
      Serial.print(teleClient.cell.getBuffer());
    }
  }
  timeoutsNet = 0;
  return state.check(STATE_CELL_CONNECTED);
}

/*******************************************************************************
  VSLAB: store-and-forward. Readings stay in the buffer until the server answers 200, and go out oldest first,
  several per upload, once the oldest has waited VSLAB_BATCH_SECONDS (or a batch is full). Upstream sent the
  newest reading alone and discarded it before knowing whether the send worked. docs/store-and-forward.md
*******************************************************************************/
#ifndef VSLAB_BATCH_SECONDS
#define VSLAB_BATCH_SECONDS 15
#endif
#define VSLAB_BATCH_MAX 15

enum { BATCH_NONE, BATCH_SENT, BATCH_REJECTED, BATCH_FAILED };
bool forceReport = false; // VSLAB: REPORT command: send now, without waiting for the batch timer

/*******************************************************************************
  VSLAB: device commands from VS-lab (docs/device-commands.md). Each "CMD <id> <sig> <command>" line is checked
  (HMAC-SHA256 with this device's key, first 16 hex characters), run once (IDs only go up; the last one is kept in
  NVS) and answered at /hub/api/ack. Without a key (VSLAB_DEVICE_KEY empty) unsigned commands ("-") are accepted,
  as VS-lab sends while DEVICE_KEY_SECRET is unset; with a key, a wrong or missing signature is ignored.
*******************************************************************************/
#ifndef VSLAB_DEVICE_KEY
#define VSLAB_DEVICE_KEY ""
#endif
uint32_t lastCommandId = 0;
bool lastCommandOk = false;
char lastCommandResult[48] = {0};

// first 16 hex characters of HMAC-SHA256(key, text)
void hmac16(const char* key, const char* text, char* out)
{
  uint8_t mac[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t*)key, strlen(key),
    (const uint8_t*)text, strlen(text), mac);
  for (int i = 0; i < 8; i++) sprintf(out + i * 2, "%02x", mac[i]);
  out[16] = 0;
}

void answerCommand(uint32_t id, bool ok, const char* result)
{
  char sig[17] = "-";
  const char* key = VSLAB_DEVICE_KEY;
  if (key[0]) {
    char text[128];
    snprintf(text, sizeof(text), "ack\n%s\n%u\n%d\n%s", devid, (unsigned int)id, ok ? 1 : 0, result);
    hmac16(key, text, sig);
  }
  bool sent = teleClient.ack(id, ok, result, sig);
  Serial.print("[CMD] #");
  Serial.print(id);
  Serial.print(ok ? " done: " : " failed: ");
  Serial.print(result);
  Serial.println(sent ? " (answered)" : " (answer not delivered; VS-lab will resend)");
}

void runCommand(const char* command, bool* ok, char* result, int resultSize)
{
  const char* eq = strchr(command, '=');
  int nameLen = eq ? eq - command : strlen(command);
  const char* value = eq ? eq + 1 : "";
  *ok = true;
  if (nameLen == 5 && !strncmp(command, "ALERT", 5)) {
    if (!strcmp(value, "not_checked_in")) alertKind = ALERT_NOT_CHECKED_IN;
    else if (!strcmp(value, "checklist_due")) alertKind = ALERT_CHECKLIST_DUE;
    else if (!strcmp(value, "none")) alertKind = ALERT_NONE;
    else { *ok = false; snprintf(result, resultSize, "unknown alert %s", value); return; }
    lastAlertBeep = 0; // a new alert sounds straight away
    snprintf(result, resultSize, "alert %s", value);
  } else if (nameLen == 4 && !strncmp(command, "BEEP", 4)) {
    int n = atoi(value);
    if (n < 1) n = 1;
    if (n > 10) n = 10;
    beepRequest = n;
    snprintf(result, resultSize, "beeping %d", n);
  } else if (nameLen == 6 && !strncmp(command, "REPORT", 6)) {
    forceReport = true;
    snprintf(result, resultSize, "reported");
  } else if (nameLen == 5 && !strncmp(command, "RESET", 5)) {
    snprintf(result, resultSize, "restarting");
  } else {
    *ok = false;
    snprintf(result, resultSize, "not supported yet");
  }
}

void runCommands()
{
  const char* key = VSLAB_DEVICE_KEY;
  bool restart = false;
  for (uint8_t c = 0; c < teleClient.commandCount; c++) {
    // CMD <id> <sig> <command>
    char* line = teleClient.commands[c];
    char* p = line + 4;
    uint32_t id = strtoul(p, &p, 10);
    while (*p == ' ') p++;
    char sig[24] = {0};
    int n = 0;
    while (*p && *p != ' ' && n < (int)sizeof(sig) - 1) sig[n++] = *p++;
    while (*p == ' ') p++;
    const char* command = p;
    if (!id || !*command) continue;
    if (id < lastCommandId) continue;
    if (id == lastCommandId) {
      // already run: VS-lab didn't get the answer, so send it again
      answerCommand(id, lastCommandOk, lastCommandResult);
      continue;
    }
    if (key[0]) {
      char text[200], expected[17];
      snprintf(text, sizeof(text), "%s\n%u\n%s", devid, (unsigned int)id, command);
      hmac16(key, text, expected);
      if (strcmp(sig, expected)) {
        Serial.print("[CMD] #");
        Serial.print(id);
        Serial.println(" ignored: bad signature");
        continue;
      }
    }
    Serial.print("[CMD] #");
    Serial.print(id);
    Serial.print(" ");
    Serial.println(command);
    runCommand(command, &lastCommandOk, lastCommandResult, sizeof(lastCommandResult));
    lastCommandId = id;
    nvs_set_u32(nvs, "VSLAB_CMDID", id);
    nvs_commit(nvs);
    answerCommand(id, lastCommandOk, lastCommandResult);
    if (lastCommandOk && !strncmp(command, "RESET", 5)) restart = true;
  }
  teleClient.commandCount = 0;
  if (restart) {
    delay(500);
    ESP.restart();
  }
}

// put up to VSLAB_BATCH_MAX of the oldest readings into store as one upload; returns how many went in (taken from
// bufman: free them once sent, unlock them to keep them)
int packBatch(CStorageRAM& store, CBuffer** batch)
{
  int n = bufman.takeOldest(batch, VSLAB_BATCH_MAX);
  if (!n) return 0;
#if SERVER_PROTOCOL == PROTOCOL_UDP
  store.header(devid);
#endif
  // keep well inside the upload buffer: a reading that doesn't fit would be cut off
  int used = 0;
  for (; used < n && store.length() < SERIALIZE_BUFFER_SIZE * 2 / 3; used++) {
    store.timestamp(batch[used]->timestamp);
    batch[used]->serialize(store);
  }
  for (int i = used; i < n; i++) bufman.unlock(batch[i]);
  store.tailer();
  return used;
}

#ifndef VSLAB_TEST_OUTAGE_END
#define VSLAB_TEST_OUTAGE_END 120
#endif

int sendBatch(CStorageRAM& store)
{
  CBuffer* batch[VSLAB_BATCH_MAX];
  int used = packBatch(store, batch);
  if (!used) return BATCH_NONE;
  Serial.print("[DAT] ");
  Serial.println(store.buffer());

#ifdef VSLAB_TEST_OUTAGE
  // VSLAB test build: a pretend dead zone from 40 s to VSLAB_TEST_OUTAGE_END s after start-up (no upload is attempted)
  bool dead = millis() > 40000 && millis() < VSLAB_TEST_OUTAGE_END * 1000UL;
  bool sent = dead ? false : teleClient.transmit(store.buffer(), store.length());
  if (dead) Serial.println("[TEST] pretend dead zone");
#else
  bool sent = teleClient.transmit(store.buffer(), store.length());
#endif
  store.purge();
#if SERVER_PROTOCOL == PROTOCOL_UDP
  int result = sent ? BATCH_SENT : BATCH_FAILED;
#else
  // a 4xx means the server refused the data itself: sending it again can't help
  int code = teleClient.lastCode;
  int result = !sent ? BATCH_FAILED : code == 200 ? BATCH_SENT : (code >= 400 && code < 500) ? BATCH_REJECTED : BATCH_FAILED;
#endif
  for (int i = 0; i < used; i++) {
    if (result == BATCH_FAILED) bufman.unlock(batch[i]);
    else bufman.free(batch[i]);
  }
  Serial.print("[NET] ");
  Serial.print(used);
  Serial.print(result == BATCH_SENT ? " readings sent" : result == BATCH_REJECTED ? " readings refused by the server, dropped" : " readings kept to send again");
  Serial.print(", ");
  Serial.print(bufman.filled(0));
  Serial.println(" waiting");
  return result;
}

/*
  VSLAB: unsent readings survive sleep on the SD card. Waking from sleep restarts the device (RESET_AFTER_WAKEUP),
  which clears memory: field test 2026-10-27 lost 763 readings that way. Before sleeping, saveBacklog writes what's
  still waiting to VSLAB_QUEUE_PATH, one upload per line; after the restart sendSaved sends those lines first (they
  are the oldest), oldest first, and remembers in NVS (VSLAB_QOFS) how far it got. Resent lines are harmless: VS-lab
  skips readings it already has.
*/
#if STORAGE == STORAGE_SD && SERVER_PROTOCOL != PROTOCOL_UDP
#define VSLAB_SAVE_BACKLOG 1
#define VSLAB_QUEUE_PATH "/VSLABQ.TXT"
#define VSLAB_QUEUE_MAX (4UL << 20) /* 4 MB, about 15 hours of readings */
uint32_t queueOffset = 0; // bytes of the file already sent
int8_t queueState = -1; // -1 not checked yet, 0 nothing saved, 1 saved uploads to send

bool savedWaiting()
{
  if (queueState < 0 && sdMounted) {
    queueState = SD.exists(VSLAB_QUEUE_PATH) ? 1 : 0;
    if (queueState) {
      nvs_get_u32(nvs, "VSLAB_QOFS", &queueOffset);
      Serial.println("[NET] Readings saved before the last sleep: sending them first");
    }
  }
  return queueState == 1;
}

void saveBacklog(CStorageRAM& store)
{
  if (!sdMounted || !bufman.filled(0)) return;
  // the file's size, counted here: File::size() is garbage for a file that append mode has just created
  uint32_t size = 0;
  if (SD.exists(VSLAB_QUEUE_PATH)) {
    File r = SD.open(VSLAB_QUEUE_PATH, FILE_READ);
    if (r) {
      size = r.size();
      r.close();
    }
  }
  File f = SD.open(VSLAB_QUEUE_PATH, FILE_APPEND);
  if (!f) {
    Serial.println("[NET] Can't save unsent readings to the SD card");
    return;
  }
  CBuffer* batch[VSLAB_BATCH_MAX];
  int saved = 0;
  int used;
  while (size < VSLAB_QUEUE_MAX && (used = packBatch(store, batch)) > 0) {
    f.write((const uint8_t*)store.buffer(), store.length());
    f.write('\n');
    size += store.length() + 1;
    store.purge();
    for (int i = 0; i < used; i++) bufman.free(batch[i]);
    saved += used;
  }
  f.close();
  if (saved) queueState = 1;
  Serial.print("[NET] Saved ");
  Serial.print(saved);
  Serial.print(" unsent readings to the SD card");
  if (bufman.filled(0)) {
    Serial.print(", file full: ");
    Serial.print(bufman.filled(0));
    Serial.print(" dropped");
  }
  Serial.println();
}

int sendSaved(CStorageRAM& store)
{
  if (!savedWaiting()) return BATCH_NONE;
  int len = 0;
  File f = SD.open(VSLAB_QUEUE_PATH, FILE_READ);
  if (f) {
    if (queueOffset < f.size() && f.seek(queueOffset)) {
      len = f.readBytesUntil('\n', store.buffer(), SERIALIZE_BUFFER_SIZE - 1);
    }
    f.close();
  }
  if (len <= 0) {
    // all sent (or the file can't be read): start afresh
    SD.remove(VSLAB_QUEUE_PATH);
    queueOffset = 0;
    queueState = 0;
    nvs_set_u32(nvs, "VSLAB_QOFS", 0);
    nvs_commit(nvs);
    Serial.println("[NET] All saved readings sent");
    return BATCH_NONE;
  }
  store.buffer()[len] = 0;
  store.setLength(len);
  Serial.print("[DAT saved] ");
  Serial.println(store.buffer());
  bool sent = teleClient.transmit(store.buffer(), len);
  store.purge();
  int code = teleClient.lastCode;
  int result = !sent ? BATCH_FAILED : code == 200 ? BATCH_SENT : (code >= 400 && code < 500) ? BATCH_REJECTED : BATCH_FAILED;
  if (result != BATCH_FAILED) {
    queueOffset += len + 1;
    nvs_set_u32(nvs, "VSLAB_QOFS", queueOffset);
    nvs_commit(nvs);
  }
  Serial.print("[NET] Saved upload ");
  Serial.println(result == BATCH_SENT ? "sent" : result == BATCH_REJECTED ? "refused by the server, dropped" : "kept to send again");
  return result;
}
#endif

// VSLAB: after a failed upload, log the modem's view of the network (serving cell, band, signal), to tell a cell
// change or poor coverage from a modem fault
void logCellState()
{
  if (!state.check(STATE_CELL_CONNECTED)) return;
  if (!teleClient.cell.command("AT+CPSI?\r", 1000)) {
    Serial.println("[CELL] Network state: no answer");
    return;
  }
  char *p = strstr(teleClient.cell.getBuffer(), "+CPSI:");
  if (p) {
    char *q = strchr(p, '\r');
    if (q) *q = 0;
    Serial.print("[CELL] Network state: ");
    Serial.println(p + 7);
  }
}

/*******************************************************************************
  Initializing network, maintaining connection and doing transmissions
*******************************************************************************/
void telemetry(void* inst)
{
  uint32_t lastRssiTime = 0;
  uint8_t connErrors = 0;
  uint8_t cellFailures = 0; // VSLAB: failed modem starts in a row
  uint32_t retryAt = 0; // VSLAB: no upload attempt before this time (after a failed one)
  CStorageRAM store;
  store.init(
#if BOARD_HAS_PSRAM
    (char*)heap_caps_malloc(SERIALIZE_BUFFER_SIZE, MALLOC_CAP_SPIRAM),
#else
    (char*)malloc(SERIALIZE_BUFFER_SIZE),
#endif
    SERIALIZE_BUFFER_SIZE
  );
  teleClient.reset();

  for (;;) {
    if (state.check(STATE_STANDBY)) {
      if (state.check(STATE_CELL_CONNECTED) || state.check(STATE_WIFI_CONNECTED)) {
        // VSLAB: send what's still waiting before signing off: the device restarts when it wakes, clearing memory
        for (int i = 0; i < 80 && sendBatch(store) == BATCH_SENT; i++);
        snprintf(logoutInfo, sizeof(logoutInfo), "&WHY=%s", standbyReason[0] ? standbyReason : "unknown");
        Serial.print("[NET] Signing off: ");
        Serial.println(standbyReason[0] ? standbyReason : "unknown");
        teleClient.notifyExtra = logoutInfo;
        teleClient.shutdown();
        teleClient.notifyExtra = 0;
        netop = "";
        ip = "";
        rssi = 0;
      }
#if VSLAB_SAVE_BACKLOG
      saveBacklog(store);
#endif
      state.clear(STATE_NET_READY | STATE_CELL_CONNECTED | STATE_WIFI_CONNECTED);
      teleClient.reset();
      bufman.purge();
      netParked = true; // VSLAB

      uint32_t t = millis();
      do {
        delay(1000);
      } while (state.check(STATE_STANDBY) && millis() - t < 1000L * PING_BACK_INTERVAL);
      if (state.check(STATE_STANDBY)) {
        // VSLAB: the supply voltage with every parked check-in (&BV=, centivolts like PID 0x24), so VS-lab sees a
        // battery draining while the machine is parked, not only just before the next start
        static char pingInfo[16];
        float volts = readSupplyVolts();
        snprintf(pingInfo, sizeof(pingInfo), "&BV=%u", (unsigned int)(volts * 100));
        Serial.print("[NET] Parked check-in, supply ");
        Serial.print(volts, 2);
        Serial.println(" V");
        teleClient.notifyExtra = pingInfo;
        // start ping
#if ENABLE_WIFI
        if (wifiSSID[0]) { 
          Serial.print("[WIFI] Joining SSID:");
          Serial.println(wifiSSID);
          teleClient.wifi.begin(wifiSSID, wifiPassword);
        }
        if (teleClient.wifi.setup()) {
          Serial.println("[WIFI] Ping...");
          teleClient.ping();
        }
        else
#endif
        {
          if (initCell()) {
            Serial.println("[CELL] Ping...");
            teleClient.ping();
          }
        }
        teleClient.shutdown();
        teleClient.notifyExtra = 0; // VSLAB
        state.clear(STATE_CELL_CONNECTED | STATE_WIFI_CONNECTED);
      }
      continue;
    }
    netParked = false; // VSLAB

#if ENABLE_WIFI
    if (wifiSSID[0] && !state.check(STATE_WIFI_CONNECTED)) {
      Serial.print("[WIFI] Joining SSID:");
      Serial.println(wifiSSID);
      teleClient.wifi.begin(wifiSSID, wifiPassword);
      teleClient.wifi.setup();
    }
#endif

    while (state.check(STATE_WORKING)) {
#if ENABLE_WIFI
      if (wifiSSID[0]) {
        if (!state.check(STATE_WIFI_CONNECTED) && teleClient.wifi.connected()) {
          ip = teleClient.wifi.getIP();
          if (ip.length()) {
            Serial.print("[WIFI] IP:");
            Serial.println(ip);
          }
          connErrors = 0;
          if (teleClient.connect()) {
            state.set(STATE_WIFI_CONNECTED | STATE_NET_READY);
            // VSLAB: no routine "connected" beep: beeps are for operator alerts (docs/operator-alerts.md)
            // switch off cellular module when wifi connected
            if (state.check(STATE_CELL_CONNECTED)) {
              teleClient.cell.end();
              state.clear(STATE_CELL_CONNECTED);
              Serial.println("[CELL] Deactivated");
            }
          }
        } else if (state.check(STATE_WIFI_CONNECTED) && !teleClient.wifi.connected()) {
          Serial.println("[WIFI] Disconnected");
          state.clear(STATE_WIFI_CONNECTED);
        }
      }
#endif
      if (!state.check(STATE_WIFI_CONNECTED) && !state.check(STATE_CELL_CONNECTED)) {
        connErrors = 0;
        if (!initCell() || !teleClient.connect()) {
          teleClient.cell.end();
          state.clear(STATE_NET_READY | STATE_CELL_CONNECTED);
          Serial.println("[CELL] Deactivated");
          // VSLAB: wait 15 s, 30 s, 1 min, then 3 min before trying again, after each failure in a row (upstream
          // always waited 3 min, "to avoid operator banning"; field test 2026-10-27: the modem came back on the next
          // try, so the wait only lost data). Stop waiting when the device goes to sleep.
          static const uint8_t waitSeconds[] = {15, 30, 60, 180};
          uint32_t wait = waitSeconds[cellFailures < 3 ? cellFailures : 3] * 1000UL;
          if (cellFailures < 255) cellFailures++;
          Serial.print("[CELL] Trying again in ");
          Serial.print(wait / 1000);
          Serial.println(" s");
          for (uint32_t t = millis(); millis() - t < wait && state.check(STATE_WORKING); ) delay(500);
          break;
        }
        cellFailures = 0; // VSLAB
        Serial.println("[CELL] In service");
        state.set(STATE_NET_READY);
        if (teleClient.login) teleClient.notifyExtra = 0; // VSLAB: the restart reason goes with the first sign-in only
        // VSLAB: no routine "connected" beep: beeps are for operator alerts (docs/operator-alerts.md)
        runCommands();
      }

      if (millis() - lastRssiTime > SIGNAL_CHECK_INTERVAL * 1000) {
#if ENABLE_WIFI
        if (state.check(STATE_WIFI_CONNECTED))
        {
          rssi = teleClient.wifi.RSSI();
        }
        else
#endif
        {
          rssi = teleClient.cell.RSSI();
        }
        if (rssi) {
          Serial.print("RSSI:");
          Serial.print(rssi);
          Serial.println("dBm");
        }
        lastRssiTime = millis();

#if ENABLE_WIFI
        if (wifiSSID[0] && !state.check(STATE_WIFI_CONNECTED)) {
          teleClient.wifi.begin(wifiSSID, wifiPassword);
        }
#endif
      }

      // VSLAB: send in batches, oldest first, once the oldest reading has waited long enough (see sendBatch)
      uint32_t oldest;
      int waiting = bufman.filled(&oldest);
#if VSLAB_SAVE_BACKLOG
      bool saved = savedWaiting(); // readings saved before the last sleep go first, without waiting
#else
      bool saved = false;
#endif
      if ((!saved && (!waiting || (waiting < VSLAB_BATCH_MAX && millis() - oldest < VSLAB_BATCH_SECONDS * 1000UL && !forceReport))) || millis() < retryAt) {
        delay(50);
        continue;
      }

      // start transmission
#ifdef PIN_LED
      if (ledMode == 0) digitalWrite(PIN_LED, HIGH);
#endif

      forceReport = false;
      int result = BATCH_NONE;
#if VSLAB_SAVE_BACKLOG
      if (saved) result = sendSaved(store);
#endif
      if (result == BATCH_NONE) result = sendBatch(store);
      runCommands(); // VSLAB: device commands from the reply
      if (result == BATCH_SENT) {
        connErrors = 0;
        showStats();
      } else if (result == BATCH_FAILED) {
        retryAt = millis() + 5000; // VSLAB: pause before trying again
        timeoutsNet++;
        connErrors++;
        printTimeoutStats();
        logCellState(); // VSLAB
        if (connErrors < MAX_CONN_ERRORS_RECONNECT) {
          // quick reconnect
          teleClient.connect(true);
        }
      }
#ifdef PIN_LED
      if (ledMode == 0) digitalWrite(PIN_LED, LOW);
#endif

      teleClient.inbound();

      if (state.check(STATE_CELL_CONNECTED) && !teleClient.cell.check(1000)) {
        Serial.println("[CELL] Not in service");
        // VSLAB: switch the modem fully off before starting it again. One that has stopped answering ignores the
        // short power-key pulse that starts it (field test 2026-10-27: no answer for 70 s, fine after a power-off).
        teleClient.cell.end();
        state.clear(STATE_NET_READY | STATE_CELL_CONNECTED);
        break;
      }

      if (syncInterval > 10000 && millis() - teleClient.lastSyncTime > syncInterval) {
        Serial.println("[NET] Poor connection");
        timeoutsNet++;
        if (!teleClient.connect()) {
          connErrors++;
        }
      }

      if (connErrors >= MAX_CONN_ERRORS_RECONNECT) {
#if ENABLE_WIFI
        if (state.check(STATE_WIFI_CONNECTED)) {
          teleClient.wifi.end();
          state.clear(STATE_NET_READY | STATE_WIFI_CONNECTED);
          break;
        }
#endif
        if (state.check(STATE_CELL_CONNECTED)) {
          teleClient.cell.end();
          state.clear(STATE_NET_READY | STATE_CELL_CONNECTED);
          break;
        }
      }

      if (deviceTemp >= COOLING_DOWN_TEMP) {
        // device too hot, cool down by pause transmission
        Serial.print("HIGH DEVICE TEMP: ");
        Serial.println(deviceTemp);
        bufman.purge();
      }

    }
  }
}

/*******************************************************************************
  Implementing stand-by mode
*******************************************************************************/
void standby()
{
  state.set(STATE_STANDBY);
  // VSLAB: a sleeping machine stays quiet; VS-lab resends the alert after the next wake if it's still needed
  alertKind = ALERT_NONE;
  beepRequest = 0;
#if STORAGE != STORAGE_NONE
  if (state.check(STATE_STORAGE_READY)) {
    logger.end();
  }
#endif

#if !GNSS_ALWAYS_ON && GNSS == GNSS_STANDALONE
  if (state.check(STATE_GPS_READY)) {
    Serial.println("[GNSS] OFF");
    sys.gpsEnd(true);
    state.clear(STATE_GPS_READY | STATE_GPS_ONLINE);
    gd = 0;
  }
#endif

  state.clear(STATE_WORKING | STATE_OBD_READY | STATE_STORAGE_READY);
  // this will put co-processor into sleep mode
#if ENABLE_OLED
  oled.print("STANDBY");
  delay(1000);
  oled.clear();
#endif
  Serial.println("STANDBY");
  obd.enterLowPowerMode();
#if ENABLE_MEMS
  calibrateMEMS();
  waitMotion(-1);
#elif ENABLE_OBD
  do {
    delay(5000);
  } while (obd.getVoltage() < JUMPSTART_VOLTAGE);
#else
  delay(5000);
#endif
  Serial.println("WAKEUP");
  sys.resetLink();
#if RESET_AFTER_WAKEUP
  // VSLAB: the restart clears memory, so let the network task save unsent readings first (saveBacklog); it may be
  // busy starting the modem, so wait up to 3 minutes
  for (int i = 0; i < 1800 && !netParked; i++) delay(100);
#if ENABLE_MEMS
  if (mems) mems->end();  
#endif
  ESP.restart();
#endif  
  state.clear(STATE_STANDBY);
}

/*******************************************************************************
  Tasks to perform in idle/waiting time
*******************************************************************************/
void genDeviceID(char* buf)
{
    uint64_t seed = ESP.getEfuseMac() >> 8;
    for (int i = 0; i < 8; i++, seed >>= 5) {
      byte x = (byte)seed & 0x1f;
      if (x >= 10) {
        x = x - 10 + 'A';
        switch (x) {
          case 'B': x = 'W'; break;
          case 'D': x = 'X'; break;
          case 'I': x = 'Y'; break;
          case 'O': x = 'Z'; break;
        }
      } else {
        x += '0';
      }
      buf[i] = x;
    }
    buf[8] = 0;
}

void showSysInfo()
{
  Serial.print("CPU:");
  Serial.print(ESP.getCpuFreqMHz());
  Serial.print("MHz FLASH:");
  Serial.print(ESP.getFlashChipSize() >> 20);
  Serial.println("MB");
  Serial.print("IRAM:");
  Serial.print(ESP.getHeapSize() >> 10);
  Serial.print("KB");
#if BOARD_HAS_PSRAM
  if (psramInit()) {
    Serial.print(" PSRAM:");
    Serial.print(esp_spiram_get_size() >> 20);
    Serial.print("MB");
  }
#endif
  Serial.println();

  int rtc = rtc_clk_slow_freq_get();
  if (rtc) {
    Serial.print("RTC:");
    Serial.println(rtc);
  }

#if ENABLE_OLED
  oled.clear();
  oled.print("CPU:");
  oled.print(ESP.getCpuFreqMHz());
  oled.print("Mhz ");
  oled.print(getFlashSize() >> 10);
  oled.println("MB Flash");
#endif

  Serial.print("DEVICE ID:");
  Serial.println(devid);
#if ENABLE_OLED
  oled.print("DEVICE ID:");
  oled.println(devid);
#endif
}

void loadConfig()
{
  nvs_get_u32(nvs, "VSLAB_CMDID", &lastCommandId); // VSLAB: device commands already run
  size_t len;
  len = sizeof(apn);
  apn[0] = 0;
  nvs_get_str(nvs, "CELL_APN", apn, &len);
  if (!apn[0]) {
    strcpy(apn, CELL_APN);
  }

#if ENABLE_WIFI
  len = sizeof(wifiSSID);
  nvs_get_str(nvs, "WIFI_SSID", wifiSSID, &len);
  len = sizeof(wifiPassword);
  nvs_get_str(nvs, "WIFI_PWD", wifiPassword, &len);
#endif
}

void processBLE(int timeout)
{
#if ENABLE_BLE
  static byte echo = 0;
  char* cmd;
  if (!(cmd = ble_recv_command(timeout))) {
    return;
  }

  char *p = strchr(cmd, '\r');
  if (p) *p = 0;
  char buf[48];
  int bufsize = sizeof(buf);
  int n = 0;
  if (echo) n += snprintf(buf + n, bufsize - n, "%s\r", cmd);
  Serial.print("[BLE] ");
  Serial.print(cmd);
  if (!strcmp(cmd, "UPTIME") || !strcmp(cmd, "TICK")) {
    n += snprintf(buf + n, bufsize - n, "%lu", millis());
  } else if (!strcmp(cmd, "BATT")) {
    n += snprintf(buf + n, bufsize - n, "%.2f", (float)(analogRead(A0) * 42) / 4095);
  } else if (!strcmp(cmd, "RESET")) {
#if STORAGE
    logger.end();
#endif
    ESP.restart();
    // never reach here
  } else if (!strcmp(cmd, "OFF")) {
    standbyReason = "bluetooth_off"; // VSLAB
    state.set(STATE_STANDBY);
    state.clear(STATE_WORKING);
    n += snprintf(buf + n, bufsize - n, "OK");
  } else if (!strcmp(cmd, "ON")) {
    state.clear(STATE_STANDBY);
    n += snprintf(buf + n, bufsize - n, "OK");
  } else if (!strcmp(cmd, "ON?")) {
    n += snprintf(buf + n, bufsize - n, "%u", state.check(STATE_STANDBY) ? 0 : 1);
  } else if (!strcmp(cmd, "APN?")) {
    n += snprintf(buf + n, bufsize - n, "%s", *apn ? apn : "DEFAULT");
  } else if (!strncmp(cmd, "APN=", 4)) {
    n += snprintf(buf + n, bufsize - n, nvs_set_str(nvs, "CELL_APN", strcmp(cmd + 4, "DEFAULT") ? cmd + 4 : "") == ESP_OK ? "OK" : "ERR");
    loadConfig();
  } else if (!strcmp(cmd, "NET_OP")) {
    if (state.check(STATE_WIFI_CONNECTED)) {
#if ENABLE_WIFI
      n += snprintf(buf + n, bufsize - n, "%s", wifiSSID[0] ? wifiSSID : "-");
#endif
    } else {
      snprintf(buf + n, bufsize - n, "%s", netop.length() ? netop.c_str() : "-");
      char *p = strchr(buf + n, ' ');
      if (p) *p = 0;
      n += strlen(buf + n);
    }
  } else if (!strcmp(cmd, "NET_IP")) {
    n += snprintf(buf + n, bufsize - n, "%s", ip.length() ? ip.c_str() : "-");
  } else if (!strcmp(cmd, "NET_PACKET")) {
      n += snprintf(buf + n, bufsize - n, "%u", teleClient.txCount);
  } else if (!strcmp(cmd, "NET_DATA")) {
      n += snprintf(buf + n, bufsize - n, "%u", teleClient.txBytes);
  } else if (!strcmp(cmd, "NET_RATE")) {
      n += snprintf(buf + n, bufsize - n, "%u", teleClient.startTime ? (unsigned int)((uint64_t)(teleClient.txBytes + teleClient.rxBytes) * 3600 / (millis() - teleClient.startTime)) : 0);
  } else if (!strcmp(cmd, "RSSI")) {
    n += snprintf(buf + n, bufsize - n, "%d", rssi);
#if ENABLE_WIFI
  } else if (!strcmp(cmd, "SSID?")) {
    n += snprintf(buf + n, bufsize - n, "%s", wifiSSID[0] ? wifiSSID : "-");
  } else if (!strncmp(cmd, "SSID=", 5)) {
    const char* p = cmd + 5;
    n += snprintf(buf + n, bufsize - n, nvs_set_str(nvs, "WIFI_SSID", strcmp(p, "-") ? p : "") == ESP_OK ? "OK" : "ERR");
    loadConfig();
  } else if (!strcmp(cmd, "WPWD?")) {
    n += snprintf(buf + n, bufsize - n, "%s", wifiPassword[0] ? wifiPassword : "-");
  } else if (!strncmp(cmd, "WPWD=", 5)) {
    const char* p = cmd + 5;
    n += snprintf(buf + n, bufsize - n, nvs_set_str(nvs, "WIFI_PWD", strcmp(p, "-") ? p : "") == ESP_OK ? "OK" : "ERR");
    loadConfig();
#else
  } else if (!strcmp(cmd, "SSID?") || !strcmp(cmd, "WPWD?")) {
    n += snprintf(buf + n, bufsize - n, "-");
#endif
#if ENABLE_MEMS
  } else if (!strcmp(cmd, "TEMP")) {
    n += snprintf(buf + n, bufsize - n, "%d", (int)deviceTemp);
  } else if (!strcmp(cmd, "ACC")) {
    n += snprintf(buf + n, bufsize - n, "%.1f/%.1f/%.1f", acc[0], acc[1], acc[2]);
  } else if (!strcmp(cmd, "GYRO")) {
    n += snprintf(buf + n, bufsize - n, "%.1f/%.1f/%.1f", gyr[0], gyr[1], gyr[2]);
  } else if (!strcmp(cmd, "GF")) {
    n += snprintf(buf + n, bufsize - n, "%f", (float)sqrt(acc[0]*acc[0] + acc[1]*acc[1] + acc[2]*acc[2]));
#endif
  } else if (!strcmp(cmd, "ATE0")) {
    echo = 0;
    n += snprintf(buf + n, bufsize - n, "OK");
  } else if (!strcmp(cmd, "ATE1")) {
    echo = 1;
    n += snprintf(buf + n, bufsize - n, "OK");
  } else if (!strcmp(cmd, "FS")) {
    n += snprintf(buf + n, bufsize - n, "%u",
#if STORAGE == STORAGE_NONE
    0
#else
    logger.size()
#endif
      );
  } else if (!memcmp(cmd, "01", 2)) {
    byte pid = hex2uint8(cmd + 2);
    for (byte i = 0; i < sizeof(obdData) / sizeof(obdData[0]); i++) {
      if (obdData[i].pid == pid) {
        n += snprintf(buf + n, bufsize - n, "%d", obdData[i].value);
        pid = 0;
        break;
      }
    }
    if (pid) {
      int value;
      if (obd.readPID(pid, value)) {
        n += snprintf(buf + n, bufsize - n, "%d", value);
      } else {
        n += snprintf(buf + n, bufsize - n, "N/A");
      }
    }
  } else if (!strcmp(cmd, "VIN")) {
    n += snprintf(buf + n, bufsize - n, "%s", vin[0] ? vin : "N/A");
  } else if (!strcmp(cmd, "LAT") && gd) {
    n += snprintf(buf + n, bufsize - n, "%f", gd->lat);
  } else if (!strcmp(cmd, "LNG") && gd) {
    n += snprintf(buf + n, bufsize - n, "%f", gd->lng);
  } else if (!strcmp(cmd, "ALT") && gd) {
    n += snprintf(buf + n, bufsize - n, "%d", (int)gd->alt);
  } else if (!strcmp(cmd, "SAT") && gd) {
    n += snprintf(buf + n, bufsize - n, "%u", (unsigned int)gd->sat);
  } else if (!strcmp(cmd, "SPD") && gd) {
    n += snprintf(buf + n, bufsize - n, "%d", (int)(gd->speed * 1852 / 1000));
  } else if (!strcmp(cmd, "CRS") && gd) {
    n += snprintf(buf + n, bufsize - n, "%u", (unsigned int)gd->heading);
  } else {
    n += snprintf(buf + n, bufsize - n, "ERROR");
  }
  Serial.print(" -> ");
  Serial.println((p = strchr(buf, '\r')) ? p + 1 : buf);
  if (n < bufsize - 1) {
    buf[n++] = '\r';
  } else {
    n = bufsize - 1;
  }
  buf[n] = 0;
  ble_send_response(buf, n, cmd);
#else
  if (timeout) delay(timeout);
#endif
}

void setup()
{
  delay(500);

  // Initialize NVS
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    // NVS partition was truncated and needs to be erased
    // Retry nvs_flash_init
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK( err );
  err = nvs_open("storage", NVS_READWRITE, &nvs);
  if (err == ESP_OK) {
    loadConfig();
  }

#if ENABLE_OLED
  oled.begin();
  oled.setFontSize(FONT_SIZE_SMALL);
#endif
  // initialize USB serial
  Serial.begin(115200);

  // VSLAB: why the ESP32 restarted, sent with the first sign-in (&RST=) so VS-lab can tell a crash or watchdog
  // from an unplug or a wake from sleep
  {
    const char* why;
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON: why = "power_on"; break;
    case ESP_RST_SW: why = "software"; break; // includes waking from sleep (RESET_AFTER_WAKEUP)
    case ESP_RST_PANIC: why = "crash"; break;
    case ESP_RST_INT_WDT: case ESP_RST_TASK_WDT: case ESP_RST_WDT: why = "watchdog"; break;
    case ESP_RST_BROWNOUT: why = "brownout"; break;
    case ESP_RST_DEEPSLEEP: why = "deep_sleep"; break;
    case ESP_RST_EXT: why = "external"; break;
    default: why = "unknown"; break;
    }
    snprintf(bootInfo, sizeof(bootInfo), "&RST=%s", why);
    teleClient.notifyExtra = bootInfo;
    Serial.print("[BOOT] restart reason: ");
    Serial.println(why);
  }

#ifdef VSLAB_MODEM_PASSTHROUGH
  // VSLAB test mode: the PC talks straight to the modem (AT commands by hand); nothing else runs
  sys.begin(false, true);
  Serial.println("[PASSTHROUGH] starting modem...");
  if (teleClient.cell.begin(&sys)) {
    Serial.print("[PASSTHROUGH] modem: ");
    Serial.println(teleClient.cell.deviceName());
  } else {
    Serial.println("[PASSTHROUGH] no modem");
  }
  Serial.println("[PASSTHROUGH] ready");
  return;
#endif

  // init LED pin
#ifdef PIN_LED
  pinMode(PIN_LED, OUTPUT);
  if (ledMode == 0) digitalWrite(PIN_LED, HIGH);
#endif

  // generate unique device ID
  genDeviceID(devid);

#if CONFIG_MODE_TIMEOUT
  configMode();
#endif

#if LOG_EXT_SENSORS == 1
  pinMode(PIN_SENSOR1, INPUT);
  pinMode(PIN_SENSOR2, INPUT);
#elif LOG_EXT_SENSORS == 2
  adc1_config_width(ADC_WIDTH_BIT_12);
  adc1_config_channel_atten(ADC1_CHANNEL_0, ADC_ATTEN_DB_11);
  adc1_config_channel_atten(ADC1_CHANNEL_1, ADC_ATTEN_DB_11);
#endif

  // show system information
  showSysInfo();

  bufman.init();
  
  //Serial.print(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) >> 10);
  //Serial.println("KB");

#if ENABLE_OBD
  if (sys.begin()) {
    Serial.print("TYPE:");
    Serial.println(sys.devType);
    obd.begin(sys.link);
  }
#else
  // VSLAB: start the co-processor link too, only to learn the board type: board type 15 (Model H) reads its
  // supply voltage on A0, which we then send without OBD (see the voltage reading in the data loop).
  if (sys.begin()) {
    Serial.print("TYPE:");
    Serial.println(sys.devType);
  }
#endif

#if ENABLE_MEMS
if (!state.check(STATE_MEMS_READY)) do {
  Serial.print("MEMS:");
  mems = new ICM_42627;
  byte ret = mems->begin();
  if (ret) {
    state.set(STATE_MEMS_READY);
    Serial.println("ICM-42627");
    break;
  }
  delete mems;
  mems = new ICM_20948_I2C;
  ret = mems->begin();
  if (ret) {
    state.set(STATE_MEMS_READY);
    Serial.println("ICM-20948");
    break;
  } 
  delete mems;
  /*
  mems = new MPU9250;
  ret = mems->begin();
  if (ret) {
    state.set(STATE_MEMS_READY);
    Serial.println("MPU-9250");
    break;
  }
  */
  mems = 0;
  Serial.println("NO");
} while (0);
#endif

#if ENABLE_HTTPD
  IPAddress ip;
  if (serverSetup(ip)) {
    Serial.println("HTTPD:");
    Serial.println(ip);
#if ENABLE_OLED
    oled.println(ip);
#endif
  } else {
    Serial.println("HTTPD:NO");
  }
#endif

  state.set(STATE_WORKING);

#if ENABLE_BLE
  // init BLE
  ble_init("FreematicsPlus");
#endif

  // initialize components
  initialize();

  // initialize network and maintain connection
  subtask.create(telemetry, "telemetry", 2, 8192);

#ifdef PIN_LED
  digitalWrite(PIN_LED, LOW);
#endif
}

void loop()
{
#ifdef VSLAB_MODEM_PASSTHROUGH
  // VSLAB test mode: relay bytes between the PC and the modem
  char buf[128];
  int n = 0;
  while (Serial.available() && n < (int)sizeof(buf)) buf[n++] = Serial.read();
  if (n) sys.xbWrite(buf, n);
  n = sys.xbRead(buf, sizeof(buf), 10);
  if (n > 0) Serial.write((const uint8_t*)buf, n);
  return;
#endif
  // error handling
  if (!state.check(STATE_WORKING)) {
    standby();
#ifdef PIN_LED
    if (ledMode == 0) digitalWrite(PIN_LED, HIGH);
#endif
    initialize();
#ifdef PIN_LED
    digitalWrite(PIN_LED, LOW);
#endif
    return;
  }

  // collect and log data
  process();
}
