#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <Arduino_JSON.h>
#include <HTTPClient.h>

#include <Adafruit_NeoPixel.h>


/////////////////////// settings //////////////////
const char AP_SSID[]  = "LAMP-wifi-Setup";
const int  PIN_RESET  = 34;

const char SERVER[]   = "http://162.243.26.172:8500";  // ← 서버 PC 로컬 IP로 변경
const char USER[]     = "user2";                      // ← 플래시 구울 때 유저 이름으로 변경

const int  PIXEL_PIN   = 13;   // ← NeoPixel 연결 GPIO 핀
const int  PIXEL_COUNT = 7;    // ← LED 개수

const unsigned long POLL_INTERVAL = 1000;  // ms

// lerp factor per 10ms tick — ~300ms to reach target
const float ALPHA = 0.1f;
////////////////////////////////////////////////////


/////////////////////// globals //////////////////
Preferences          prefs;
WebServer            apServer(80);
Adafruit_NeoPixel    strip(PIXEL_COUNT, PIXEL_PIN, NEO_GRB + NEO_KHZ800);
unsigned long        lastPoll = 0;

// smooth transition: current and target values (float for sub-step precision)
float curR = 0, curG = 0, curB = 0, curBri = 0;
float tgtR = 0, tgtG = 0, tgtB = 0, tgtBri = 0;




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
  } else {
    Serial.println("Failed to connect — clearing credentials");
    prefs.begin("wifi", false);
    prefs.clear();
    prefs.end();
    ESP.restart();
  }
}
////////////////////////////////////////////////////


/////////////////////// NeoPixel polling //////////////////
void pollState() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(800);
  http.begin(String(SERVER) + "/api/state?user=" + USER);
  int code = http.GET();

  if (code != 200) {
    Serial.printf("GET /api/state → %d\n", code);
    http.end();
    return;
  }

  String payload = http.getString();
  http.end();

  JSONVar doc = JSON.parse(payload);
  if (JSON.typeof(doc) == "undefined") {
    Serial.println("JSON parse error");
    return;
  }

  bool isOn       = (bool)doc["isOn"];
  int  r          = (int)doc["rgb"][0];
  int  g          = (int)doc["rgb"][1];
  int  b          = (int)doc["rgb"][2];
  int  brightness = (int)doc["brightness"];  // 0–254

  // set targets only — updateStrip() in loop() lerps toward them
  if (!isOn) {
    tgtBri = 0;
  } else {
    tgtR   = r;
    tgtG   = g;
    tgtB   = b;
    tgtBri = brightness;
  }

  Serial.printf("isOn=%d  rgb=(%d,%d,%d)  bri=%d\n", isOn, r, g, b, brightness);
}
////////////////////////////////////////////////////


/////////////////////// smooth transition //////////////////
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
  Serial.begin(9600);

  strip.begin();
  strip.setBrightness(0);
  strip.show();

  pinMode(PIN_RESET, INPUT_PULLUP);

  prefs.begin("wifi", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();

  if (ssid.isEmpty()) {
    startProvisioning();
  }
  connectWiFi(ssid, pass);

  pollState();  // immediate first poll
}
////////////////////////////////////////////////////


/////////////////////// loop ///////////////////////
void loop() {
  // reset button: HIGH = pressed
  if (digitalRead(PIN_RESET) == HIGH) {
    checkReset();
  }

  // WiFi auto-reconnect
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost — reconnecting...");
    prefs.begin("wifi", true);
    String ssid = prefs.getString("ssid", "");
    String pass = prefs.getString("pass", "");
    prefs.end();
    connectWiFi(ssid, pass);
  }

  // poll server and update NeoPixel
  unsigned long now = millis();
  if (now - lastPoll >= POLL_INTERVAL) {
    lastPoll = now;
    pollState();
  }

  updateStrip();  // lerp current → target every tick
  delay(10);
}
////////////////////////////////////////////////////
