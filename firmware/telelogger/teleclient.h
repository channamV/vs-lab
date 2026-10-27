#include "config.h"

// VSLAB: our firmware's version, sent with every sign-in (&FW=) and compared with UPDATE commands
// (docs/firmware-updates.md). Raise it for every build that goes to devices; test builds can set it with
// -DVSLAB_FW_VERSION=\"...\".
#ifndef VSLAB_FW_VERSION
#define VSLAB_FW_VERSION "vs-0.2.5"
#endif

#define EVENT_LOGIN 1
#define EVENT_LOGOUT 2
#define EVENT_SYNC 3
#define EVENT_RECONNECT 4
#define EVENT_COMMAND 5
#define EVENT_ACK 6
#define EVENT_PING 7

#define BUFFER_STATE_EMPTY 0
#define BUFFER_STATE_FILLING 1
#define BUFFER_STATE_FILLED 2
#define BUFFER_STATE_LOCKED 3

#define ELEMENT_UINT8 0
#define ELEMENT_UINT16 1
#define ELEMENT_UINT32 2
#define ELEMENT_INT32 3
#define ELEMENT_FLOAT 4
#define ELEMENT_FLOAT_D1 5 /* floating-point data with 1 decimal place*/
#define ELEMENT_FLOAT_D2 6 /* floating-point data with 2 decimal places*/

typedef struct {
    uint16_t pid;
    uint8_t type;
    uint8_t count;
} ELEMENT_HEAD;

class CBuffer
{
public:
    CBuffer(uint8_t* mem);
    void add(uint16_t pid, uint8_t type, void* values, int bytes, uint8_t count = 1);
    void purge();
    void serialize(CStorage& store);
    uint32_t timestamp;
    uint16_t offset;
    uint8_t total;
    uint8_t state;
private:
    uint8_t* m_data;
};

class CBufferManager
{
public:
    void init();
    void purge();
    void free(CBuffer* slot);
    CBuffer* getFree();
    CBuffer* getOldest();
    CBuffer* getNewest();
    // VSLAB: store-and-forward (see sendBatch in telelogger.ino)
    int takeOldest(CBuffer** out, int max);
    void unlock(CBuffer* slot);
    int filled(uint32_t* oldest);
    void printStats();
private:
    CBuffer** slots = 0;
    CBuffer* last = 0;
    uint32_t total = 0;
};

class TeleClient
{
public:
    virtual void reset()
    {
        txCount = 0;
        txBytes = 0;
        rxBytes = 0;
        login = false;
        startTime = millis();
    }
    virtual bool notify(byte event, const char* payload = 0) { return true; }
    virtual bool connect() { return true; }
    virtual bool transmit(const char* packetBuffer, unsigned int packetSize)  { return true; }
    virtual void inbound() {}
    uint32_t txCount = 0;
    uint32_t txBytes = 0;
    uint32_t rxBytes = 0;
    uint32_t lastSyncTime = 0;
    uint16_t feedid = 0;
    uint32_t startTime = 0;
    uint8_t packets = 0;
    bool login = false;
    uint16_t lastCode = 0; // VSLAB: HTTP status of the last transmit (0 = no reply)
    const char* notifyExtra = 0; // VSLAB: extra query for the next notifications (&RST= on login, &WHY= on logout)
    // VSLAB: device commands ("CMD <id> <sig> <command>" lines) from the latest replies, run by telelogger.ino
    void collectCommands(const char* reply);
    char commands[5][224]; // an UPDATE command with a signed download link is ~170 characters
    uint8_t commandCount = 0;
};

class TeleClientUDP : public TeleClient
{
public:
    bool notify(byte event, const char* payload = 0);
    bool connect(bool quick = false);
    bool transmit(const char* packetBuffer, unsigned int packetSize);
    bool ping();
    void inbound();
    bool verifyChecksum(char* data);
    void shutdown();
#if ENABLE_WIFI
    WifiUDP wifi;
#endif
    CellUDP cell;
};

class TeleClientHTTP : public TeleClient
{
public:
    bool notify(byte event, const char* payload = 0);
    bool connect(bool quick = false);
    bool transmit(const char* packetBuffer, unsigned int packetSize);
    bool ping();
    void shutdown();
    bool ack(uint32_t id, bool ok, const char* result, const char* sig); // VSLAB: answer a device command
    bool post(const char* path, const char* body, int bodySize); // VSLAB: e.g. the restart report; true on 200
    int download(const char* path, uint32_t offset, uint32_t length, uint8_t* out); // VSLAB: firmware piece
#if ENABLE_WIFI
    WifiHTTP wifi;
#endif
    CellHTTP cell;
};