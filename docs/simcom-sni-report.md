# SIMCom bug report: SIM7670G SSL ignores enableSNI

**To:** SIMCom technical support / distributor FAE
**From:** Craig, Veristart (craig@veristart.ca)
**Subject:** SIM7670G-LNGV — `AT+CSSLCFG="enableSNI"` accepted but SNI never sent (firmware SIM767XM5_B01V03_240309)

---

Hello,

We're developing a vehicle telematics device on the SIM7670G-LNGV. The module's SSL stack does not send the TLS Server Name Indication (SNI) extension, even when it's enabled with `AT+CSSLCFG="enableSNI"`. Many cloud hosts reject connections without SNI, so the module can't reach them over HTTPS.

## Module

| Item | Value |
|---|---|
| Model | SIM7670G-LNGV |
| Firmware (`AT+CGMR`) | 2368B01SIM767XM5A |
| Firmware build | SIM767XM5_B01V03_240309 |
| Network | LTE Cat-1, Canada, Soracom SIM |
| Host MCU | ESP32 (Freematics ONE+ Model H) |

## Expected
After `AT+CSSLCFG="enableSNI",<ctx>,1`, TLS ClientHello messages from that SSL context carry the SNI extension with the target hostname. This should apply to both the CCH service (`AT+CCHOPEN`) and the HTTP(S) service (`AT+HTTPACTION`).

## Actual
The command is accepted and reads back as enabled, but SNI is never sent.

```
AT+CSSLCFG=?          -> lists "enableSNI",(0-9),(0,1)
AT+CSSLCFG="enableSNI",0,1
OK
AT+CSSLCFG?           -> +CSSLCFG: 0,4,0,1,300,"","","",1,0,"",0,0   (enableSNI shows 1)
AT+CSSLCFG="sni",...  -> ERROR (not supported)
```

## Evidence
Target: `vs-lab-platform-tpj9.vercel.app:443`. This host returns a different certificate depending on whether SNI is present:

| ClientHello | Certificate served |
|---|---|
| With SNI | Hostname certificate (Google Trust Services chain → GTS Root R1) |
| Without SNI | `CN=no-sni.vercel-infra.com` (Let's Encrypt YR1 → Root YR → ISRG Root X1) |

### Test 1: verify against the SNI chain
- Settings: `authmode=1`, only GTS Root R1 loaded.
- Result: handshake fails, `+CCHOPEN` error 15 / HTTP 715.

### Test 2: verify against the no-SNI chain
- Settings: `authmode=1`, only ISRG Root X1 loaded, `ignorecertCN=1`.
- Result: handshake succeeds.
- The module therefore received the **no-SNI** certificate.

### Test 3: HTTP request after handshake
- Every request returns `421 Misdirected Request`, over both CCH and `AT+HTTP...`.
- That's the server's response to a connection without SNI.

A PC request without SNI gets the same `421` and the same certificate. The same request with SNI succeeds.

### Variations tried (all gave the same result)
- SSL context 0 and context 1.
- `enableSNI` set before and after `AT+HTTPINIT`.
- Fresh `AT+HTTPTERM` / `AT+HTTPINIT` for each request.
- URL with and without an explicit `:443`.
- CCH service: `AT+CCHSTART`, `AT+CCHSSLCFG=0,<ctx>`, then `AT+CCHOPEN=0,"<host>",443,2`.

## Minimal reproduction
```
AT+CSSLCFG="sslversion",0,4
AT+CSSLCFG="authmode",0,0
AT+CSSLCFG="enableSNI",0,1
AT+CCHSTART
AT+CCHSSLCFG=0,0
AT+CCHOPEN=0,"vs-lab-platform-tpj9.vercel.app",443,2
AT+CCHSEND=0,<len>
GET / HTTP/1.1\r\nHost: vs-lab-platform-tpj9.vercel.app\r\nConnection: close\r\n\r\n
```
Expected: 2xx/3xx. Actual: `HTTP/1.1 421 Misdirected Request`.

Any Vercel-hosted site reproduces this. Many hosts behind CDNs (Cloudflare, Vercel, some AWS configurations) require SNI.

## Questions
1. Is this a known issue in SIM767XM5_B01V03_240309?
2. Is there a firmware version where `enableSNI` is applied, for CCH and for the HTTP service? Please send the version and release notes.
3. How do we get that firmware: USB update procedure, and is FOTA supported?
4. Does the SIM7600 series (for example, SIM7600G-H) have the same limitation on current firmware? We're choosing a module for a custom board and need to know whether SNI works.

We can run test builds and send logs or packet captures if useful.

Thank you,
Craig
Veristart
