#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <Arduino_JSON.h>
#include <WebSocketsClient.h>

#include <Adafruit_NeoPixel.h>


/////////////////////// settings //////////////////
const char AP_SSID[]  = "LAMP-wifi-Setup";
// const int  PIN_RESET  = 5;
const int  PIN_RESET  = 2;

const char WS_HOST[]  = "162.243.26.172";
const int  WS_PORT    = 8080;
const char USER[]     = "hyubin";                      // 플래시 구울 때 유저 이름으로 변경

// const int  PIXEL_PIN   = 4;   // ← NeoPixel 연결 GPIO 핀
const int  PIXEL_PIN   = 12;   // ← NeoPixel 연결 GPIO 핀
const int  PIXEL_COUNT = 7;    // ← LED 개수

// lerp factor per 10ms tick
const float ALPHA = 0.1f;
////////////////////////////////////////////////////


/////////////////////// globals //////////////////
Preferences          prefs;
WebServer            apServer(80);
WebSocketsClient     webSocket;
Adafruit_NeoPixel    strip(PIXEL_COUNT, PIXEL_PIN, NEO_GRB + NEO_KHZ800);

// smooth transition: current and target values (volatile = shared across cores)
volatile float curR = 0, curG = 0, curB = 0, curBri = 0;
volatile float tgtR = 0, tgtG = 0, tgtB = 0, tgtBri = 0;
////////////////////////////////////////////////////


/////////////////////// provisioning page //////////////////
const char PROV_HTML[] PROGMEM = R"(
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WiFi Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: monospace;
      background: #d9d9d6;
      display: flex;
      justify-content: center;
      padding: 48px 24px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 16px;
      width: 100%;
      max-width: 320px;
    }
    h2 {
      font-size: 11px;
      letter-spacing: 0.25em;
      font-weight: 400;
      color: #6b6b6b;
    }
    input {
      padding: 10px;
      border: 1px solid #bcbcb8;
      background: transparent;
      font-family: monospace;
      font-size: 14px;
      outline: none;
    }
    button {
      padding: 10px;
      border: 1px solid #1a1a1a;
      background: transparent;
      font-family: monospace;
      font-size: 10px;
      letter-spacing: 0.2em;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <form method="POST" action="/save">
    <h2>WIFI SETUP</h2>
    <input name="ssid" placeholder="Wifi name" required />
    <input name="pass" type="password" placeholder="Password" />
    <button type="submit">CONNECT</button>
  </form>
</body>
</html>
)";
////////////////////////////////////////////////////


/////////////////////// AP mode //////////////////
void breathingTick() {
  // ~3-second sine-wave breath cycle, warm white
  float t   = (millis() % 3000) / 3000.0f;
  float bri = (sinf(t * TWO_PI - HALF_PI) + 1.0f) / 2.0f;  // 0..1
  strip.setBrightness((int)(bri * 255));
  strip.fill(strip.Color(255, 180, 80));
  strip.show();
}

void startProvisioning() {
  WiFi.softAP(AP_SSID);
  Serial.print("AP mode — connect to: ");
  Serial.println(AP_SSID);
  Serial.print("then open: http://");
  Serial.println(WiFi.softAPIP());

  apServer.on("/", HTTP_GET, []() {
    apServer.send(200, "text/html", PROV_HTML);
  });

  apServer.on("/save", HTTP_POST, []() {
    String ssid = apServer.arg("ssid");
    String pass = apServer.arg("pass");

    prefs.begin("wifi", false);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    prefs.end();

    apServer.send(200, "text/html",
      "<p style='font-family:monospace;padding:48px 24px'>Saved. Rebooting...</p>");
    delay(1500);
    ESP.restart();
  });

  apServer.begin();
  while (true) {
    apServer.handleClient();
    breathingTick();
    delay(10);
  }
}
////////////////////////////////////////////////////


/////////////////////// WiFi connect //////////////////
void connectWiFi(const String& ssid, const String& pass) {
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.print("Connecting to: ");
  Serial.println(ssid);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(1000);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    for(int i = 0; i < 3; i++) {
      strip.setBrightness(255);
      strip.fill(strip.Color(255, 255, 255));
      strip.show();
      delay(100);
      strip.setBrightness(0);
      strip.fill(strip.Color(0, 0, 0));
      strip.show();
      delay(100);
    }
  } else {
    Serial.println("Failed to connect — clearing credentials");
    prefs.begin("wifi", false);
    prefs.clear();
    prefs.end();
    ESP.restart();
  }
}
////////////////////////////////////////////////////


/////////////////////// WebSocket //////////////////
void applyStateJSON(const String& payload) {
  JSONVar doc = JSON.parse(payload);
  if (JSON.typeof(doc) == "undefined") {
    Serial.println("WebSocket JSON parse error");
    return;
  }

  bool isOn       = (bool)doc["isOn"];
  int  r          = (int)doc["rgb"][0];
  int  g          = (int)doc["rgb"][1];
  int  b          = (int)doc["rgb"][2];
  int  brightness = (int)doc["brightness"];

  if (!isOn) {
    tgtBri = 0;
  } else {
    tgtR   = r;
    tgtG   = g;
    tgtB   = b;
    tgtBri = brightness;
  }

  Serial.printf("WS state  isOn=%d  rgb=(%d,%d,%d)  bri=%d\n", isOn, r, g, b, brightness);
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("WebSocket connected");
      break;

    case WStype_DISCONNECTED:
      Serial.println("WebSocket disconnected");
      break;

    case WStype_TEXT: {
      String message;
      message.reserve(length);
      for (size_t i = 0; i < length; i++) {
        message += (char)payload[i];
      }
      applyStateJSON(message);
      break;
    }

    default:
      break;
  }
}
////////////////////////////////////////////////////


/////////////////////// smooth transition //////////////////
// strip은 Core 1(loop)에서만 접근 — thread-safe
void updateStrip() {
  curR   += (tgtR   - curR)   * ALPHA;
  curG   += (tgtG   - curG)   * ALPHA;
  curB   += (tgtB   - curB)   * ALPHA;
  curBri += (tgtBri - curBri) * ALPHA;

  strip.setBrightness((int)curBri);
  strip.fill(strip.Color((int)curR, (int)curG, (int)curB));
  strip.show();
}
////////////////////////////////////////////////////


/////////////////////// reset //////////////////
void checkReset() {
  Serial.println("Reset button held — clearing credentials");
  prefs.begin("wifi", false);
  prefs.clear();
  prefs.end();
  delay(500);
  ESP.restart();
}
////////////////////////////////////////////////////


/////////////////////// setup //////////////////////
void setup() {
  Serial.begin(115200);

  strip.begin();
  strip.setBrightness(0);
  strip.show();

  pinMode(PIN_RESET, INPUT);

  prefs.begin("wifi", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();

  if (ssid.isEmpty()) {
    startProvisioning();
  }
  connectWiFi(ssid, pass);

  String wsPath = String("/ws?user=") + USER;
  webSocket.begin(WS_HOST, WS_PORT, wsPath);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(1000);
  webSocket.enableHeartbeat(15000, 3000, 2);
}
////////////////////////////////////////////////////


/////////////////////// loop (Core 1) ///////////////////////
void loop() {
  
  if (digitalRead(PIN_RESET) == HIGH) {
    checkReset();
  }

  webSocket.loop();
  updateStrip();  // Core 1에서 LED 지속 업데이트
  delay(10);
}
////////////////////////////////////////////////////
