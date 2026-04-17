/* Step 1: Get Weather Data
*every 4 minutes,
fetch current weather in NYC
append to weather_log.json.
*/

// ========== Imports ==========
const fs = require("fs");
const path = require("path");

// ========== Config ==========
const LAT = 40.7128;
const LON = -74.0060;
const INTERVAL_MS = 4 * 1000;
const LOG_FILE = path.join(__dirname, "weather_log.json");
// ===========================


// === timestamp in ISO format ===
function ts() {
    return new Date().toISOString();
    }
// ===============================


// === fetch weather data from Open-Meteo API ===
async function fetchWeather() {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", LAT);
    url.searchParams.set("longitude", LON);
    url.searchParams.set("current", "weather_code");
    url.searchParams.set("daily", "sunrise,sunset");
    url.searchParams.set("timezone", "America/New_York");

    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

// === append log entry to file ===
function appendLog(entry) {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

// === main loop ===
async function tick() {
    try {
        const data  = await fetchWeather();
        const entry = {
            timestamp:    ts(),
            weather_code: data.current.weather_code,
            sunrise:      data.daily.sunrise[0],
            sunset:       data.daily.sunset[0],
        };
        appendLog(entry);
        console.log(`${entry.timestamp} - code:${entry.weather_code}, sunrise:${entry.sunrise}, sunset:${entry.sunset}`);
    } catch (err) {
        console.error(`Error fetching weather: ${err}`);
    }
}
console.log(`log: ${LOG_FILE}`);
setInterval(tick, INTERVAL_MS);