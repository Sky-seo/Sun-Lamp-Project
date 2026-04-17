/////////////////////// imports //////////////////
const http = require("http");
const fs   = require("fs");
const path = require("path");
const { analyze, readLatestEntry } = require("./analyze");
//////////////////////////////////////////////////


// settings
const PORT = 8080;

// manual mode: warm orange color and 5 brightness steps
const WARM_ORANGE       = [255, 210, 140];
const MANUAL_BRI_LEVELS = [50, 100, 150, 200, 254];


/////////////////////// app state //////////////////
const USER_LIST = [
  "user1", "user2", "user3", "user4", "user5",
  "user6", "user7", "user8", "user9", "user10",
];

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
function syncWeather(state) {
  try {
    const entry  = readLatestEntry();
    const result = analyze(entry);
    state.entry         = entry;
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
    if (urlPath === "/") {
      const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (urlPath === "/dashboard.css") {
      const css = fs.readFileSync(path.join(__dirname, "dashboard.css"), "utf8");
      res.writeHead(200, { "Content-Type": "text/css" });
      return res.end(css);
    }
    if (urlPath === "/dashboard.js") {
      const js = fs.readFileSync(path.join(__dirname, "dashboard.js"), "utf8");
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(js);
    }

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

    // button 2: cycle manual brightness
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

    // dashboard - button: step manual brightness down
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

// sync weather for all users on boot
USER_LIST.forEach(u => syncWeather(getState(u)));

// auto-sync weather every 5 minutes (live mode users only)
setInterval(function () {
  USER_LIST.forEach(u => {
    const s = getState(u);
    if (s.mode === "live") syncWeather(s);
  });
}, 5 * 60 * 1000);

server.listen(PORT, function () {
  log("server running at http://localhost:" + PORT);
});

//////////////////////////////////////////////////
