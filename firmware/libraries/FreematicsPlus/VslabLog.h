/*
  VSLAB: a copy of the serial log, for the log file on the memory card (docs/device-diagnostics.md).

  Every file that includes a Freematics header prints through VslabSerial (the #define at the end): it writes to the
  USB serial port exactly as before and keeps a copy in PSRAM, each line starting with the time (UTC once the clock
  is set from GPS, else "+<seconds since start-up>"). telelogger.ino takes the copy every few seconds and appends it
  to /LOG/<start-up number>.TXT. ESP-IDF's own messages (log_e...) and crash dumps don't go through Serial.
*/
#ifndef VSLAB_LOG_H
#define VSLAB_LOG_H

#include <Arduino.h>

class VslabLogSerial : public Stream
{
public:
    void begin(unsigned long baud);
    size_t write(uint8_t c) override;
    size_t write(const uint8_t* data, size_t size) override;
    using Print::write;
    int available() override;
    int read() override;
    int peek() override;
    void flush() override;
    // takes up to `size` bytes of the copy not saved yet; returns how many
    size_t take(char* out, size_t size);
    // bytes lost because the copy was full (nothing took it in time)
    uint32_t dropped = 0;
};

extern VslabLogSerial VslabSerial;
#define Serial VslabSerial

#endif
