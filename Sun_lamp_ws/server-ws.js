/////////////////////// imports //////////////////
const http = require("http");
const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const { analyze } = require("./analyze");
//////////////////////////////////////////////////


// settings
const PORT = process.env.PORT || 8080;

// NYC coordinates (Open-Meteo)
const LAT = 40.7128;
const LON = -74.0060;

// manual mode: warm orange color and 5 brightness steps
const WARM_ORANGE       = [255, 210, 140];
const MANUAL_BRI_LEVELS = [50, 100, 150, 200, 254];


/////////////////////// app state //////////////////
const USER_LIST = [
  "hyubin", "shajin", "user3", "user4", "user5",
  "user6", "user7", "user8", "user9", "user10",
];

// global weather cache shared across all users (same NYC weather for everyone)
let latestWeatherEntry = null;

function defaultState() {
  return {
    timestamp:      null,
    entry:          null,
    result:         null,
    weatherStatus:  "unknown",
    lastError:      null,
    mode:           "live",
    isOn:           true,
    manualBriLevel: 0,
    manualColor:    [255, 210, 140],
    rgb:            [0, 0, 0],
    brightness:     0,
    alarm: { enabled: false, time: "07:00", mode: "live", lastFiredDate: null },
  };
}

const states = {};
USER_LIST.forEach(u => { states[u] = defaultState(); });

const wsClients = {};
USER_LIST.forEach(u => { wsClients[u] = new Set(); });

function getState(user) {
  if (!states[user]) states[user] = defaultState();
  return states[user];
}
////////////////////////////////////////////////////


// log helper with timestamp
function log(msg) {
  const time = new Date().toTimeString().slice(0, 8);
  console.log("[" + time + "] " + msg);
}


// current date and HH:MM in New York time
function getNyDateTime() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const h = get("hour") === "24" ? "00" : get("hour");
  return {
    date: get("year") + "-" + get("month") + "-" + get("day"),
    time: h + ":" + get("minute"),
  };
}


// compute active rgb and brightness from current mode/state
function computeActive(state) {
  if (!state.isOn) {
    state.rgb        = [0, 0, 0];
    state.brightness = 0;
    return;
  }
  if (state.mode === "manual") {
    state.rgb        = state.manualColor;
    state.brightness = MANUAL_BRI_LEVELS[state.manualBriLevel];
  } else {
    state.rgb        = state.result ? state.result.rgb        : WARM_ORANGE;
    state.brightness = state.result ? state.result.brightness : MANUAL_BRI_LEVELS[0];
  }
}


/////////////////////// WebSocket //////////////////

function encodeWebSocketText(text) {
  const payload = Buffer.from(text);

  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }

  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function sendWebSocketJSON(socket, obj) {
  if (!socket.destroyed) socket.write(encodeWebSocketText(JSON.stringify(obj)));
}

function broadcastState(user) {
  const clients = wsClients[user];
  if (!clients || clients.size === 0) return;

  const state = getState(user);
  for (const socket of clients) {
    sendWebSocketJSON(socket, state);
  }
}

function handleWebSocketUpgrade(req, socket) {
  if (parsePath(req.url) !== "/ws") {
    socket.destroy();
    return;
  }

  const user = parseUser(req.url);
  const key = req.headers["sec-websocket-key"];
  if (!user || !key) {
    socket.destroy();
    return;
  }

  if (!wsClients[user]) wsClients[user] = new Set();

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
    "\r\n",
  ].join("\r\n"));

  wsClients[user].add(socket);
  log(user + " websocket connected (" + wsClients[user].size + ")");
  sendWebSocketJSON(socket, getState(user));

  socket.on("data", chunk => {
    const opcode = chunk[0] & 0x0f;
    if (opcode === 0x8) socket.end();
    if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]));
  });

  socket.on("close", () => {
    wsClients[user].delete(socket);
    log(user + " websocket disconnected (" + wsClients[user].size + ")");
  });

  socket.on("error", () => {
    wsClients[user].delete(socket);
  });
}


/////////////////////// weather //////////////////

// fetch current weather from Open-Meteo and store in memory
async function fetchWeather() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude",  LAT);
  url.searchParams.set("longitude", LON);
  url.searchParams.set("current",   "weather_code");
  url.searchParams.set("daily",     "sunrise,sunset");
  url.searchParams.set("timezone",  "America/New_York");

  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  // API returns local NY times like "2026-04-17T06:13" with no timezone marker.
  // Use the API-provided utc_offset_seconds to convert to unambiguous UTC ISO.
  const offsetMs = data.utc_offset_seconds * 1000;
  function localToUtc(localStr) {
    // parse "YYYY-MM-DDTHH:MM" as if UTC, then undo the NY offset
    return new Date(new Date(localStr + ":00.000Z").getTime() - offsetMs).toISOString();
  }

  latestWeatherEntry = {
    timestamp:    new Date().toISOString(),
    weather_code: data.current.weather_code,
    sunrise:      localToUtc(data.daily.sunrise[0]),
    sunset:       localToUtc(data.daily.sunset[0]),
  };
  log("weather fetched: code=" + latestWeatherEntry.weather_code +
      "  sunrise=" + latestWeatherEntry.sunrise.slice(11, 16) +
      "  sunset="  + latestWeatherEntry.sunset.slice(11, 16));
}

// apply latest weather entry to a user state
function syncWeather(state) {
  try {
    if (!latestWeatherEntry) throw new Error("no weather data yet");
    const result = analyze(latestWeatherEntry);
    state.entry         = latestWeatherEntry;
    state.result        = result;
    state.timestamp     = new Date().toISOString();
    state.weatherStatus = "ok";
    state.lastError     = null;
  } catch (err) {
    state.weatherStatus = "error";
    state.lastError     = err.message;
    log("weather sync failed: " + err.message);
  }
  computeActive(state);
}

function checkAlarms() {
  const { date, time } = getNyDateTime();
  USER_LIST.forEach(u => {
    const state = getState(u);
    const alarm = state.alarm;
    if (!alarm.enabled) return;
    if (alarm.time !== time) return;
    if (alarm.lastFiredDate === date) return;
    alarm.lastFiredDate = date;
    state.isOn = true;
    state.mode = alarm.mode;
    if (alarm.mode === "live") syncWeather(state);
    else computeActive(state);
    log(u + " alarm fired → " + alarm.mode + " at " + time);
    broadcastState(u);
  });
}

function syncAllLiveUsers() {
  USER_LIST.forEach(u => {
    const s = getState(u);
    if (s.mode === "live") {
      syncWeather(s);
      broadcastState(u);
    }
  });
}

//////////////////////////////////////////////////


// parse ?user= from URL, return null if missing or unknown
function parseUser(rawUrl) {
  const u = new URL(rawUrl, "http://localhost");
  return u.searchParams.get("user");
}

// strip query string for route matching
function parsePath(rawUrl) {
  return rawUrl.split("?")[0];
}

// serve a local static file
function serveFile(res, fileName, contentType) {
  const content = fs.readFileSync(path.join(__dirname, fileName), "utf8");
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}


/////////////////////// HTTP server //////////////////

const server = http.createServer(async function (req, res) {
  const urlPath = parsePath(req.url);
  const method  = req.method;

  function sendJSON(statusCode, obj) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  try {

    // static files (no user needed)
    if (urlPath === "/")              return serveFile(res, "dashboard.html", "text/html; charset=utf-8");
    if (urlPath === "/dashboard.css") return serveFile(res, "dashboard.css",  "text/css");
    if (urlPath === "/dashboard.js")  return serveFile(res, "dashboard.js",   "text/javascript");

    // all /api/* routes require ?user=
    const user = parseUser(req.url);
    if (!user) return sendJSON(400, { error: "missing ?user= parameter" });
    const state = getState(user);

    // send current state — used by dashboard and HTTP fallback clients
    if (urlPath === "/api/state" && method === "GET") {
      return sendJSON(200, state);
    }

    // button 1 / dashboard: switch to live mode
    if (urlPath === "/api/live" && method === "POST") {
      state.mode = "live";
      syncWeather(state);
      log(user + " mode → live");
      broadcastState(user);
      return sendJSON(200, state);
    }

    // button 2: cycle manual brightness up
    if (urlPath === "/api/manual" && method === "POST") {
      if (state.mode === "manual") {
        state.manualBriLevel = (state.manualBriLevel + 1) % MANUAL_BRI_LEVELS.length;
      } else {
        state.mode           = "manual";
        state.manualBriLevel = 0;
      }
      computeActive(state);
      log(user + " mode → manual  level " + (state.manualBriLevel + 1) + "/5  bri " + state.brightness);
      broadcastState(user);
      return sendJSON(200, state);
    }

    // dashboard button: step manual brightness down
    if (urlPath === "/api/manual/down" && method === "POST") {
      if (state.mode === "manual") {
        state.manualBriLevel = (state.manualBriLevel - 1 + MANUAL_BRI_LEVELS.length) % MANUAL_BRI_LEVELS.length;
      } else {
        state.mode           = "manual";
        state.manualBriLevel = MANUAL_BRI_LEVELS.length - 1;
      }
      computeActive(state);
      log(user + " mode → manual  level " + (state.manualBriLevel + 1) + "/5  bri " + state.brightness);
      broadcastState(user);
      return sendJSON(200, state);
    }

    // button 3 / power button: toggle on/off
    if (urlPath === "/api/toggle" && method === "POST") {
      state.isOn = !state.isOn;
      computeActive(state);
      log(user + " toggle → " + (state.isOn ? "ON" : "OFF"));
      broadcastState(user);
      return sendJSON(200, state);
    }

    // set manual color (r, g, b in body)
    if (urlPath === "/api/color" && method === "POST") {
      let body = "";
      await new Promise(resolve => { req.on("data", c => body += c); req.on("end", resolve); });
      const { r, g, b } = JSON.parse(body);
      state.manualColor = [r, g, b];
      if (state.mode === "manual") computeActive(state);
      log(user + " color → rgb(" + r + "," + g + "," + b + ")");
      broadcastState(user);
      return sendJSON(200, state);
    }

    // set / clear alarm
    if (urlPath === "/api/alarm" && method === "POST") {
      let body = "";
      await new Promise(resolve => { req.on("data", c => body += c); req.on("end", resolve); });
      const { enabled, time, mode } = JSON.parse(body);
      state.alarm = { enabled, time, mode, lastFiredDate: null };
      log(user + " alarm → " + (enabled ? time + " " + mode : "off"));
      broadcastState(user);
      return sendJSON(200, state);
    }

    // force weather refresh
    if (urlPath === "/api/update" && method === "POST") {
      await fetchWeather();
      syncWeather(state);
      broadcastState(user);
      return sendJSON(200, state);
    }

    return sendJSON(404, { error: "Not found" });

  } catch (err) {
    log("server error: " + err.message);
    if (!res.headersSent) sendJSON(500, { error: err.message });
  }
});

server.on("upgrade", handleWebSocketUpgrade);

////////////////////////////////////////////////////


/////////////////////// startup //////////////////

// fetch weather first, then start listening
fetchWeather()
  .catch(err => log("initial weather fetch failed: " + err.message))
  .finally(() => {
    syncAllLiveUsers();

    // check alarms every 30 seconds
    setInterval(checkAlarms, 30 * 1000);

    // refresh weather every 4 minutes
    setInterval(async () => {
      try {
        await fetchWeather();
        syncAllLiveUsers();
      } catch (err) {
        log("weather refresh error: " + err.message);
      }
    }, 4 * 60 * 1000);

    server.listen(PORT, function () {
      log("server running on port " + PORT);
    });
  });

//////////////////////////////////////////////////
