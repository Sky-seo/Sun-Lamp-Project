/////////////////////// imports //////////////////
const http = require("http");
const fs   = require("fs");
const path = require("path");
const { analyze } = require("./analyze");
//////////////////////////////////////////////////


// settings
const PORT = process.env.PORT || 8500;

// NYC coordinates (Open-Meteo)
const LAT = 40.7128;
const LON = -74.0060;

// manual mode: warm orange color and 5 brightness steps
const WARM_ORANGE       = [255, 210, 140];
const MANUAL_BRI_LEVELS = [50, 100, 150, 200, 254];


/////////////////////// app state //////////////////
const USER_LIST = [
  "user1", "user2", "user3", "user4", "user5",
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
  };
}

const states = {};
USER_LIST.forEach(u => { states[u] = defaultState(); });

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

  latestWeatherEntry = {
    timestamp:    new Date().toISOString(),
    weather_code: data.current.weather_code,
    sunrise:      data.daily.sunrise[0],
    sunset:       data.daily.sunset[0],
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

function syncAllLiveUsers() {
  USER_LIST.forEach(u => {
    const s = getState(u);
    if (s.mode === "live") syncWeather(s);
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

    // send current state — polled by ESP32 and dashboard
    if (urlPath === "/api/state" && method === "GET") {
      return sendJSON(200, state);
    }

    // button 1 / dashboard: switch to live mode
    if (urlPath === "/api/live" && method === "POST") {
      state.mode = "live";
      syncWeather(state);
      log(user + " mode → live");
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
      return sendJSON(200, state);
    }

    // button 3 / power button: toggle on/off
    if (urlPath === "/api/toggle" && method === "POST") {
      state.isOn = !state.isOn;
      computeActive(state);
      log(user + " toggle → " + (state.isOn ? "ON" : "OFF"));
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
      return sendJSON(200, state);
    }

    // force weather refresh
    if (urlPath === "/api/update" && method === "POST") {
      await fetchWeather();
      syncWeather(state);
      return sendJSON(200, state);
    }

    return sendJSON(404, { error: "Not found" });

  } catch (err) {
    log("server error: " + err.message);
    if (!res.headersSent) sendJSON(500, { error: err.message });
  }
});

////////////////////////////////////////////////////


/////////////////////// startup //////////////////

// fetch weather first, then start listening
fetchWeather()
  .catch(err => log("initial weather fetch failed: " + err.message))
  .finally(() => {
    syncAllLiveUsers();

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
