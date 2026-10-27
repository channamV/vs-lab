// VSLAB: a copy of the serial log, for the log file on the memory card. See VslabLog.h.
#include "VslabLog.h"
#undef Serial // below, Serial is the real USB serial port
#include <time.h>
#include "esp_heap_caps.h"

#define VSLAB_LOG_COPY_SIZE (32 * 1024) /* about 10 s of the busiest logging; taken every few seconds */

VslabLogSerial VslabSerial;

static char* copy = 0;
static size_t head = 0; // oldest byte not taken yet
static size_t used = 0;
static bool lineStart = true;
static portMUX_TYPE copyLock = portMUX_INITIALIZER_UNLOCKED;

// the time at the start of each line: UTC once the clock is set (from GPS), else seconds since start-up
static int timePrefix(char* out, size_t size)
{
    time_t now = time(0);
    if (now > 1700000000) {
        struct tm t;
        gmtime_r(&now, &t);
        return snprintf(out, size, "%02d:%02d:%02d ", t.tm_hour, t.tm_min, t.tm_sec);
    }
    uint32_t ms = millis();
    return snprintf(out, size, "+%u.%u ", (unsigned int)(ms / 1000), (unsigned int)(ms % 1000) / 100);
}

static void keep(const char* data, size_t size)
{
    if (!copy) {
        copy = (char*)heap_caps_malloc(VSLAB_LOG_COPY_SIZE, MALLOC_CAP_SPIRAM);
        if (!copy) return;
    }
    char prefix[16];
    int prefixLen = 0;
    if (lineStart) prefixLen = timePrefix(prefix, sizeof(prefix));
    portENTER_CRITICAL(&copyLock);
    for (size_t i = 0; i < size; i++) {
        if (lineStart && prefixLen) {
            for (int k = 0; k < prefixLen && used < VSLAB_LOG_COPY_SIZE; k++) copy[(head + used++) % VSLAB_LOG_COPY_SIZE] = prefix[k];
            prefixLen = 0;
        }
        lineStart = data[i] == '\n';
        if (used < VSLAB_LOG_COPY_SIZE) copy[(head + used++) % VSLAB_LOG_COPY_SIZE] = data[i];
        else VslabSerial.dropped++;
    }
    portEXIT_CRITICAL(&copyLock);
}

void VslabLogSerial::begin(unsigned long baud)
{
    Serial.begin(baud);
}

size_t VslabLogSerial::write(uint8_t c)
{
    keep((const char*)&c, 1);
    return Serial.write(c);
}

size_t VslabLogSerial::write(const uint8_t* data, size_t size)
{
    keep((const char*)data, size);
    return Serial.write(data, size);
}

int VslabLogSerial::available() { return Serial.available(); }
int VslabLogSerial::read() { return Serial.read(); }
int VslabLogSerial::peek() { return Serial.peek(); }
void VslabLogSerial::flush() { Serial.flush(); }

size_t VslabLogSerial::take(char* out, size_t size)
{
    if (!copy) return 0;
    portENTER_CRITICAL(&copyLock);
    size_t n = used < size ? used : size;
    for (size_t i = 0; i < n; i++) out[i] = copy[(head + i) % VSLAB_LOG_COPY_SIZE];
    head = (head + n) % VSLAB_LOG_COPY_SIZE;
    used -= n;
    portEXIT_CRITICAL(&copyLock);
    return n;
}
