// Step 2: Analyze Weather Data
// every 4.5 minutes, read latest entry from weather_log.json
// determine if it's day or night, and how far through the day it is
// calculate a color and brightness for the hue bulb based on that

// ========== Imports ==========
const fs   = require("fs");
const path = require("path");

// ========== Config ==========
const LOG_FILE = path.join(__dirname, "weather_log.json");

const NIGHT_COLOR   = [255, 140, 20];  // warm amber for nighttime
const MAX_BRIGHTNESS = 254;             // live mode always runs at full brightness
const timeMin = 4.5;

/////////////////////// color helpers //////////////////
// blend two colors [r,g,b] by ratio t  (t=0 → colorA, t=1 → colorB)
// lerp each channel separately and round to integers
function blendColors(colorA, colorB, t) {
  return [
    Math.round(colorA[0] + (colorB[0] - colorA[0]) * t),
    Math.round(colorA[1] + (colorB[1] - colorA[1]) * t),
    Math.round(colorA[2] + (colorB[2] - colorA[2]) * t),
  ];
}

/////claude helpers for working with colors and gradients/////
// pick a color from a gradient at position t (0–1)
// stops format: [ [position, [r,g,b]], ... ]
function gradientColor(stops, t) {
  // clamp to ends
  if (t <= stops[0][0])                 return stops[0][1];
  if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];

  // find which two stops we're between and blend
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, color0] = stops[i];
    const [t1, color1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const localT = (t - t0) / (t1 - t0);  // 0–1 within this segment
      return blendColors(color0, color1, localT);
    }
  }
}


/////////////////////// sunlight gradient //////////////////
// color changes from sunrise → noon → sunset
const DAY_GRADIENT = [
  [0.00, [255, 80,  0]],  // sunrise   — warm orange
  [0.20, [255, 143, 70]],  // morning   — soft yellow
  [0.50, [220, 235, 255]],  // noon      — cool blue-white
  [0.80, [255, 111, 15]],  // afternoon — warm golden
  [1.00, [247, 68,  8]],  // sunset    — deep orange
];

///////////////////////////////////////////////////////////


/////////////////////// main analysis //////////////////
// takes one weather log entry, returns color + brightness for the hue bulb
function analyze(entry, now) {
  now = now || new Date();

  const sunrise   = new Date(entry.sunrise);
  const sunset    = new Date(entry.sunset);
  const nowMs     = now.getTime();
  const sunriseMs = sunrise.getTime();
  const sunsetMs  = sunset.getTime();

  const isNight = nowMs < sunriseMs || nowMs > sunsetMs;

  // step 1: pick base color based on time of day
  let color;
  let dayProgress;  // 0.0 = sunrise, 1.0 = sunset, null at night

  if (isNight) {
    color       = NIGHT_COLOR;
    dayProgress = null;
  } else {
    dayProgress = (nowMs - sunriseMs) / (sunsetMs - sunriseMs);
    color       = gradientColor(DAY_GRADIENT, dayProgress);
  }

  // step 2: brightness is always max (manual mode has its own levels)
  const brightness = MAX_BRIGHTNESS;
  return {
    isNight:     isNight,
    dayProgress: dayProgress,
    rgb:         color,
    brightness:  brightness,
  };
}
///////////////////////////////////////////////////////


// read the latest line from weather_log.json
function readLatestEntry() {
  if (!fs.existsSync(LOG_FILE)) throw new Error("weather_log.json not found");
  const text  = fs.readFileSync(LOG_FILE, "utf8").trim();
  if (!text)  throw new Error("weather_log.json is empty");
  const lines = text.split("\n");
  return JSON.parse(lines[lines.length - 1]);
}


// if run directly (node analyze.js), print current result to terminal
function tick() {
  try {
    const entry  = readLatestEntry();
    const result = analyze(entry);
    const day    = result.isNight
      ? "NIGHT"
      : (result.dayProgress * 100).toFixed(1) + "% of day";
    console.log(
      "[" + new Date().toTimeString().slice(0, 8) + "]" +
      "  bri " + String(result.brightness).padStart(3) +
      "  day " + day +
      "  rgb(" + result.rgb.join(",") + ")"
    );
  } catch (err) {
    console.error("error:", err.message);
  }
}

module.exports = { analyze, readLatestEntry };

if (require.main === module) {
  tick();
  setInterval(tick, timeMin * 60 * 1000);
}
