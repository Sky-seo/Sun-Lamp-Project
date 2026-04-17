#include <WiFi.h>
#include <HTTPClient.h>
#include "arduino_secrets.h"


/////////////////////// settings //////////////////
const char* SERVER = "http://10.23.11.210:8080";  // server PC IP

// button GPIO pins (INPUT_PULLUP → connect to GND)
const int BTN_LIVE   = 2;    // button 1: Live mode
const int BTN_MANUAL = 4;    // button 2: Manual (each press → next brightness level)
const int BTN_TOGGLE = 5;    // button 3: On/Off toggle

// const int LED_MODE   = 23;   // LED: Live=ON, Manual=OFF

const unsigned long DEBOUNCE_MS = 50;  // how long LOW must hold to count as a press

unsigned long pressStart[3] = {0, 0, 0};  // time when LOW began
bool          pressing[3]   = {false, false, false};
bool          fired[3]      = {false, false, false};  // prevent re-trigger before release
////////////////////////////////////////////////////


/////////////////////// HTTP POST //////////////////
void post(const char* endpoint) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected, skipping POST");
    return;
  }

  HTTPClient http;
  http.setTimeout(3000);  // 3s timeout — prevents watchdog reset
  http.begin(String(SERVER) + endpoint);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST("");
  http.end();

  if (code > 0)
    Serial.printf("POST %-16s → %d\n", endpoint, code);
  else
    Serial.printf("POST %-16s → failed (%s)\n", endpoint, HTTPClient::errorToString(code).c_str());
}
////////////////////////////////////////////////////


/////////////////////// setup //////////////////////
void setup() {
  Serial.begin(9600);

  pinMode(BTN_LIVE,   INPUT_PULLUP);
  pinMode(BTN_MANUAL, INPUT_PULLUP);
  pinMode(BTN_TOGGLE, INPUT_PULLUP);
  // pinMode(LED_MODE,   OUTPUT);
  // digitalWrite(LED_MODE, LOW);

  // connect to WiFi
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print("Attempting to connect to SSID: ");
    Serial.println(SECRET_SSID);
    delay(1000);
  }
  Serial.print("Connected to SSID: ");
  Serial.println(SECRET_SSID);
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Signal Strength (dBm): ");
  Serial.println(WiFi.RSSI());
}
////////////////////////////////////////////////////


/////////////////////// button handler /////////////
// LOW must hold for DEBOUNCE_MS to count as a confirmed press
// once fired, ignores further input until the button is released
void handleButton(int idx, int pin, unsigned long now, void (*action)()) {
  bool isLow = digitalRead(pin) == LOW;

  if (!isLow) {
    // button released → reset state
    pressing[idx] = false;
    fired[idx]    = false;
    return;
  }

  if (fired[idx]) return;  // ignore until released

  if (!pressing[idx]) {
    pressing[idx]   = true;
    pressStart[idx] = now;
  } else if (now - pressStart[idx] >= DEBOUNCE_MS) {
    fired[idx]    = true;
    pressing[idx] = false;
    action();
  }
}

void onLive()   { post("/api/live");   }
void onManual() { post("/api/manual"); }
void onToggle() { post("/api/toggle"); }
////////////////////////////////////////////////////


/////////////////////// loop ///////////////////////
void loop() {
  unsigned long now = millis();
  handleButton(0, BTN_LIVE,   now, onLive);
  handleButton(1, BTN_MANUAL, now, onManual);
  handleButton(2, BTN_TOGGLE, now, onToggle);
  delay(10);
}
////////////////////////////////////////////////////
