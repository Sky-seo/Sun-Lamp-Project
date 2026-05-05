// get an HTML element by its id
function getEl(id) {
  return document.getElementById(id);
}
////////////////////


// format time string like "14:30"
function formatTime(isoString) {
  if (!isoString) return "—";
  const date    = new Date(isoString);
  const hours   = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return hours + ":" + minutes;
}
////////////////////


// format how long ago something happened ("3m ago")
function formatAgo(isoString) {
  if (!isoString) return "never";
  const secondsAgo = (Date.now() - new Date(isoString).getTime()) / 1000;
  if (secondsAgo < 60)   return Math.floor(secondsAgo) + "s ago";
  if (secondsAgo < 3600) return Math.floor(secondsAgo / 60) + "m ago";
  return Math.floor(secondsAgo / 3600) + "h ago";
}


/////////////////////// timeline bar //////////////////

function updateTimeline(weatherEntry, analysisResult) {
  if (!weatherEntry || !analysisResult) return;

  // sunrise/sunset labels at each end
  getEl("sunrise-label").textContent = formatTime(weatherEntry.sunrise);
  getEl("sunset-label").textContent  = formatTime(weatherEntry.sunset);

  if (analysisResult.isNight) {
    // fill bar dimly, hide dot, show NIGHT
    getEl("timeline-fill").style.width      = "100%";
    getEl("timeline-fill").style.opacity    = "0.25";
    getEl("timeline-fill").style.background = "";
    getEl("timeline-dot").style.display     = "none";
    getEl("timeline-now").textContent       = "NIGHT";
  } else {
    // dayProgress: 0.0 = sunrise, 1.0 = sunset
    const percent = analysisResult.dayProgress * 100;

    getEl("timeline-fill").style.width      = percent + "%";
    getEl("timeline-fill").style.opacity    = "1";
    getEl("timeline-fill").style.background = "rgb(" + analysisResult.rgb.join(",") + ")";

    getEl("timeline-dot").style.display = "block";
    getEl("timeline-dot").style.left    = percent + "%";

    // current time below the dot
    const now     = new Date();
    const hours   = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    getEl("timeline-now").textContent = hours + ":" + minutes;
  }
}

////////////////////////////////////////////////////////


// apply state from the server to the page
function updateDashboard(state) {

  // power button glows orange when light is on
  if (state.isOn) {
    getEl("power-btn").classList.add("on");
  } else {
    getEl("power-btn").classList.remove("on");
  }

  // mode pill: LIVE or MANUAL 2/5 etc.
  const pill = getEl("mode-pill");
  if (state.mode === "manual") {
    const level      = (state.manualBriLevel || 0) + 1;  // 1-based
    pill.textContent = "MANUAL " + level + "/5";
    pill.className   = "mode-pill manual";
    getEl("color-row").style.display = "flex";
    // sync swatch to current manualColor
    if (state.manualColor) {
      const [r, g, b] = state.manualColor;
      getEl("color-swatch").style.background = "rgb(" + r + "," + g + "," + b + ")";
    }
  } else {
    pill.textContent = "LIVE";
    pill.className   = "mode-pill";
    getEl("color-row").style.display = "none";
  }

  updateTimeline(state.entry, state.result);

  if (state.alarm) updateAlarmUI(state.alarm);

  // last update time
  getEl("last-update").textContent = formatAgo(state.timestamp);
}


/////////////////////// alarm //////////////////

let alarmPanelOpen = false;

function updateAlarmUI(alarm) {
  const btn = getEl("alarm-btn");
  if (alarm.enabled) {
    btn.textContent = "alarm  " + alarm.time + "  " + alarm.mode;
    btn.classList.add("active");
    getEl("alarm-off-btn").style.display = "inline-block";
  } else {
    btn.textContent = "ALARM SET";
    btn.classList.remove("active");
    getEl("alarm-off-btn").style.display = "none";
  }
  getEl("alarm-time").value = alarm.time;
  const modeInput = document.querySelector('input[name="alarm-mode"][value="' + alarm.mode + '"]');
  if (modeInput) modeInput.checked = true;
}

async function postAlarm(enabled) {
  const time = getEl("alarm-time").value;
  const mode = document.querySelector('input[name="alarm-mode"]:checked').value;
  try {
    const response = await fetch(api("/api/alarm"), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ enabled, time, mode }),
    });
    const state = await response.json();
    updateDashboard(state);
  } catch (err) {
    console.error("Alarm update failed:", err);
  }
}

getEl("alarm-btn").addEventListener("click", () => {
  alarmPanelOpen = !alarmPanelOpen;
  getEl("alarm-panel").classList.toggle("open", alarmPanelOpen);
});

getEl("alarm-set-btn").addEventListener("click", async () => {
  await postAlarm(true);
  alarmPanelOpen = false;
  getEl("alarm-panel").classList.remove("open");
});

getEl("alarm-off-btn").addEventListener("click", async () => {
  await postAlarm(false);
  alarmPanelOpen = false;
  getEl("alarm-panel").classList.remove("open");
});

getEl("alarm-cancel-btn").addEventListener("click", () => {
  alarmPanelOpen = false;
  getEl("alarm-panel").classList.remove("open");
});

////////////////////////////////////////////////////////


// read ?user= from the page URL
const USER = new URLSearchParams(window.location.search).get("user") || "user1";

function api(endpoint) {
  return endpoint + "?user=" + USER;
}


// fetch state from the server and refresh the page
async function fetchAndUpdate() {
  try {
    const response = await fetch(api("/api/state"));
    const state    = await response.json();
    updateDashboard(state);
  } catch (err) {
    console.error("Could not fetch state:", err);
  }
}


// power button click: toggle light on/off
getEl("power-btn").addEventListener("click", async function () {
  try {
    const response = await fetch(api("/api/toggle"), { method: "POST" });
    const state    = await response.json();
    updateDashboard(state);
  } catch (err) {
    console.error("Toggle failed:", err);
  }
});

// sync to live button: switch back to live mode
getEl("live-btn").addEventListener("click", async function () {
  try {
    const response = await fetch(api("/api/live"), { method: "POST" });
    const state    = await response.json();
    updateDashboard(state);
  } catch (err) {
    console.error("Live sync failed:", err);
  }
});

// + button: increase manual brightness one step
getEl("bri-up-btn").addEventListener("click", async function () {
  try {
    const response = await fetch(api("/api/manual"), { method: "POST" });
    const state    = await response.json();
    updateDashboard(state);
  } catch (err) {
    console.error("Brightness up failed:", err);
  }
});

// - button: decrease manual brightness one step
getEl("bri-down-btn").addEventListener("click", async function () {
  try {
    const response = await fetch(api("/api/manual/down"), { method: "POST" });
    const state    = await response.json();
    updateDashboard(state);
  } catch (err) {
    console.error("Brightness down failed:", err);
  }
});


// color picker change → send to server
getEl("color-picker").addEventListener("input", function () {
  const hex = this.value;
  const r   = parseInt(hex.slice(1, 3), 16);
  const g   = parseInt(hex.slice(3, 5), 16);
  const b   = parseInt(hex.slice(5, 7), 16);
  getEl("color-swatch").style.background = "rgb(" + r + "," + g + "," + b + ")";
});

getEl("color-picker").addEventListener("change", async function () {
  const hex = this.value;
  const r   = parseInt(hex.slice(1, 3), 16);
  const g   = parseInt(hex.slice(3, 5), 16);
  const b   = parseInt(hex.slice(5, 7), 16);
  try {
    const response = await fetch(api("/api/color"), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ r, g, b }),
    });
    const state = await response.json();
    updateDashboard(state);
  } catch (err) {
    console.error("Color change failed:", err);
  }
});

// update current time display every second, independent of server poll
function updateClock() {
  const now     = new Date();
  const hours   = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  getEl("timeline-now").textContent = hours + ":" + minutes;
}
updateClock();
setInterval(updateClock, 1000);

// load once on startup, then refresh every 5 seconds
fetchAndUpdate();
setInterval(fetchAndUpdate, 5000);
