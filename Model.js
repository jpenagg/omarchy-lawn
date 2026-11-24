// Pure logic for the Lawn plugin: the log, the weather and climate responses,
// and the advice drawn from them. No QML here, so node can run it (see
// tests/model.test.js).
//
// Everything read from a file or the network is treated as untrusted: it is
// validated, bounded, and reduced to numbers, ISO dates, and known ids before
// the panel sees it.

var MAX_LOG_ENTRIES = 400
var MAX_FORECAST_DAYS = 40
var MAX_FORECAST_HOURS = 96
var MAX_NAME_LENGTH = 64
var MAX_RESPONSE_BYTES = 65536
var MAX_ARCHIVE_BYTES = 1048576
var MAX_SUGGESTIONS = 5
var MAX_QUERY_LENGTH = 64
var MAX_NOTIFIED = 200
var DAY_MS = 86400000

// Turf needs roughly 80% of reference evapotranspiration.
var TURF_COEFFICIENT = 0.8

// ---- Dates. Days are "YYYY-MM-DD" strings in local time throughout.

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  var y = parseInt(value.slice(0, 4), 10)
  var m = parseInt(value.slice(5, 7), 10)
  var d = parseInt(value.slice(8, 10), 10)
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function dayNumber(date) {
  return Math.round(Date.UTC(parseInt(date.slice(0, 4), 10), parseInt(date.slice(5, 7), 10) - 1, parseInt(date.slice(8, 10), 10)) / DAY_MS)
}

// Whole days from one date to another; negative when `to` is earlier.
function daysBetween(from, to) {
  if (!isDate(from) || !isDate(to)) return null
  return dayNumber(to) - dayNumber(from)
}

function dateAfter(date, days) {
  var d = new Date((dayNumber(date) + days) * DAY_MS)
  var month = d.getUTCMonth() + 1
  var day = d.getUTCDate()
  return d.getUTCFullYear() + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day
}

// Days since January 1 of the date's own year: 0 for New Year's Day.
function dayOfYear(date) {
  return dayNumber(date) - dayNumber(date.slice(0, 4) + "-01-01")
}

function boundedNumber(value, min, max) {
  if (typeof value !== "number" && typeof value !== "string") return null
  if (typeof value === "string" && !/^-?\d+(\.\d+)?$/.test(value)) return null
  var n = Number(value)
  return isFinite(n) && n >= min && n <= max ? n : null
}

// ---- The log: {"done": {job id: [dates the job was checked off]}}.

function cleanDates(list) {
  if (!Array.isArray(list)) return []
  var seen = {}
  var out = []
  for (var i = 0; i < list.length && i < MAX_LOG_ENTRIES * 4; i++) {
    if (!isDate(list[i]) || seen[list[i]]) continue
    seen[list[i]] = true
    out.push(list[i])
  }
  out.sort()
  return out.slice(-MAX_LOG_ENTRIES)
}

// Only jobs the calendar knows are kept, so a hand-edited file cannot grow
// the log with keys of its own.
function cleanDone(done) {
  var out = {}
  if (!done || typeof done !== "object" || Array.isArray(done)) return out
  var ids = jobIds()
  for (var i = 0; i < ids.length; i++) {
    var dates = cleanDates(done[ids[i]])
    if (dates.length > 0) out[ids[i]] = dates
  }
  return out
}

function cleanLog(log) {
  var data = log && typeof log === "object" && !Array.isArray(log) ? log : {}
  return { done: cleanDone(data.done) }
}

function parseLog(raw) {
  try {
    return cleanLog(JSON.parse(String(raw || "")))
  } catch (e) {
    return cleanLog(null)
  }
}

function serialiseLog(log) {
  return JSON.stringify(cleanLog(log), null, 2) + "\n"
}

// ---- Location, in the shape of Omarchy's weather.json and geo.omarchy.org.

function cleanName(value) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(0, MAX_NAME_LENGTH)
}

// A {name, latitude, longitude} object from anywhere (a file, the network,
// shell.json) reduced to a plain bounded name and valid coordinates.
function cleanLocation(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { name: "", latitude: null, longitude: null }
  var latitude = boundedNumber(data.latitude, -90, 90)
  var longitude = boundedNumber(data.longitude, -180, 180)
  var located = latitude !== null && longitude !== null
  return { name: cleanName(data.name), latitude: located ? latitude : null, longitude: located ? longitude : null }
}

function parseLocation(raw) {
  try {
    return cleanLocation(JSON.parse(String(raw || "")))
  } catch (e) {
    return cleanLocation(null)
  }
}

function hasCoordinates(location) {
  return !!location && typeof location.latitude === "number" && typeof location.longitude === "number"
}

// The location to save in shell.json: coordinates to two decimals, which is
// as exact as a lawn's weather needs.
function storedLocation(location) {
  var clean = cleanLocation(location)
  if (!hasCoordinates(clean)) return null
  return { name: clean.name, latitude: Number(clean.latitude.toFixed(2)), longitude: Number(clean.longitude.toFixed(2)) }
}

// The lawn's location: the one set in the panel, else the Weather widget's,
// else wherever the network appears to be. `source` says which.
function pickLocation(own, weather, network) {
  var choices = [["own", own], ["weather", weather], ["network", network]]
  for (var i = 0; i < choices.length; i++) {
    if (hasCoordinates(choices[i][1])) {
      return { name: choices[i][1].name, latitude: choices[i][1].latitude, longitude: choices[i][1].longitude, source: choices[i][0] }
    }
  }
  return { name: "", latitude: null, longitude: null, source: "none" }
}

function locationKey(location) {
  return hasCoordinates(location) ? location.latitude.toFixed(2) + "," + location.longitude.toFixed(2) : ""
}

// ---- Town search, through Open-Meteo's geocoder.

function geocodeUrl(query) {
  var text = cleanName(String(query || "")).slice(0, MAX_QUERY_LENGTH)
  if (text.length < 2) return ""
  return "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(text)
    + "&count=" + MAX_SUGGESTIONS + "&language=en&format=json"
}

// Suggestion rows: {name, description, latitude, longitude}.
function parseGeocoding(raw) {
  var text = String(raw || "")
  if (text === "" || text.length > MAX_RESPONSE_BYTES) return []
  try {
    var results = JSON.parse(text).results
    if (!Array.isArray(results)) return []
    var out = []
    for (var i = 0; i < results.length && out.length < MAX_SUGGESTIONS; i++) {
      var place = cleanLocation(results[i])
      if (place.name === "" || !hasCoordinates(place)) continue
      var region = [cleanName(results[i].admin1), cleanName(results[i].country)].filter(function(part) { return part !== "" })
      out.push({ name: place.name, description: region.join(", "), latitude: place.latitude, longitude: place.longitude })
    }
    return out
  } catch (e) {
    return []
  }
}

// ---- Weather. Open-Meteo's response reduced to bounded numbers: two weeks
// of days either side of today, and the hours around now.

// Coordinates go out rounded to two decimals (about a kilometer): plenty for
// soil temperature and rain, and no more exact than it needs to be.
function forecastUrl(location) {
  if (!hasCoordinates(location)) return ""
  return "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + location.latitude.toFixed(2)
    + "&longitude=" + location.longitude.toFixed(2)
    + "&current=temperature_2m,precipitation,soil_temperature_6cm"
    + "&hourly=precipitation,temperature_2m,soil_temperature_6cm&past_hours=24&forecast_hours=40"
    + "&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_min,sunset"
    + "&past_days=14&forecast_days=4&timezone=auto"
}

function column(list, index) {
  return Array.isArray(list) ? list[index] : undefined
}

function isDateTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && isDate(value.slice(0, 10))
    && parseInt(value.slice(11, 13), 10) < 24
}

function parseConditions(raw) {
  var text = String(raw || "")
  if (text === "" || text.length > MAX_RESPONSE_BYTES) return null
  try {
    var data = JSON.parse(text)
    if (!data || typeof data !== "object") return null
    var daily = data.daily
    if (!daily || typeof daily !== "object" || !Array.isArray(daily.time)) return null

    var days = []
    for (var i = 0; i < daily.time.length && days.length < MAX_FORECAST_DAYS; i++) {
      if (!isDate(daily.time[i])) continue
      var sunset = column(daily.sunset, i)
      days.push({
        date: daily.time[i],
        rainMm: boundedNumber(column(daily.precipitation_sum, i), 0, 2000),
        et0Mm: boundedNumber(column(daily.et0_fao_evapotranspiration, i), 0, 50),
        maxC: boundedNumber(column(daily.temperature_2m_max, i), -90, 70),
        minC: boundedNumber(column(daily.temperature_2m_min, i), -90, 70),
        sunsetHour: isDateTime(sunset) ? parseInt(sunset.slice(11, 13), 10) : null
      })
    }
    if (days.length === 0) return null

    var hours = []
    var soilTotal = 0
    var soilCount = 0
    var hourly = data.hourly && typeof data.hourly === "object" && Array.isArray(data.hourly.time) ? data.hourly : { time: [] }
    for (var h = 0; h < hourly.time.length && hours.length < MAX_FORECAST_HOURS; h++) {
      if (!isDateTime(hourly.time[h])) continue
      hours.push({
        date: hourly.time[h].slice(0, 10),
        hour: parseInt(hourly.time[h].slice(11, 13), 10),
        rainMm: boundedNumber(column(hourly.precipitation, h), 0, 500),
        tempC: boundedNumber(column(hourly.temperature_2m, h), -90, 70)
      })
      var soil = boundedNumber(column(hourly.soil_temperature_6cm, h), -90, 90)
      if (soil !== null) {
        soilTotal += soil
        soilCount++
      }
    }

    var current = data.current && typeof data.current === "object" ? data.current : {}
    var soilNow = boundedNumber(current.soil_temperature_6cm, -90, 90)
    return {
      now: isDateTime(current.time) ? current.time : "",
      soilC: soilNow,
      // Averaged over the hours around now, so the dormancy call does not
      // flip between a cold morning and a mild afternoon.
      soilMeanC: soilCount > 0 ? soilTotal / soilCount : soilNow,
      airC: boundedNumber(current.temperature_2m, -90, 70),
      rainingMm: boundedNumber(current.precipitation, 0, 500),
      days: days,
      hours: hours
    }
  } catch (e) {
    return null
  }
}

function dayFor(conditions, date) {
  var days = conditions && conditions.days ? conditions.days : []
  for (var i = 0; i < days.length; i++) {
    if (days[i].date === date) return days[i]
  }
  return null
}

// Sum of one daily value over the days `from`..`to` relative to today
// (0 is today, negative is the past). Null when none of them is known.
function sumOver(conditions, today, field, from, to) {
  var total = 0
  var known = false
  for (var offset = from; offset <= to; offset++) {
    var day = dayFor(conditions, dateAfter(today, offset))
    if (!day || day[field] === null) continue
    total += day[field]
    known = true
  }
  return known ? total : null
}

function meanTemp(day) {
  if (!day || day.maxC === null || day.minC === null) return null
  return (day.maxC + day.minC) / 2
}

// ---- Grasses. `name` is both the setting value and the English label.
// mowIn is the mowing height in inches, germDays how long seed takes to come
// up (null where the grass is laid as sod or plugs), zones the USDA hardiness
// zones it suits,
// and seedEndShift moves the end of the seeding window for slow (bluegrass)
// or quick (ryegrass) germinators.

var GRASSES = [
  { id: "tall-fescue", name: "Tall fescue", warm: false, mowIn: [3, 4], germDays: [7, 12], zones: [4, 8], seedEndShift: 0 },
  { id: "kentucky-bluegrass", name: "Kentucky bluegrass", warm: false, mowIn: [2.5, 3.5], germDays: [14, 30], zones: [3, 7], seedEndShift: -10 },
  { id: "perennial-ryegrass", name: "Perennial ryegrass", warm: false, mowIn: [2, 3], germDays: [5, 10], zones: [5, 7], seedEndShift: 7 },
  { id: "fine-fescue", name: "Fine fescue", warm: false, mowIn: [2.5, 4], germDays: [7, 14], zones: [3, 7], seedEndShift: 0 },
  { id: "bermuda", name: "Bermuda", warm: true, mowIn: [1, 2], germDays: [7, 21], zones: [7, 10], seedEndShift: 0 },
  { id: "zoysia", name: "Zoysia", warm: true, mowIn: [1, 2.5], germDays: [14, 21], zones: [6, 10], seedEndShift: 0 },
  { id: "st-augustine", name: "St. Augustine", warm: true, mowIn: [2.5, 4], germDays: null, zones: [8, 11], seedEndShift: 0 },
  { id: "centipede", name: "Centipede", warm: true, mowIn: [1, 2], germDays: [14, 28], zones: [7, 10], seedEndShift: 0 },
  { id: "bahia", name: "Bahia", warm: true, mowIn: [3, 4], germDays: [14, 28], zones: [8, 11], seedEndShift: 0 },
  { id: "buffalo", name: "Buffalograss", warm: true, mowIn: [2, 3], germDays: [14, 30], zones: [5, 9], seedEndShift: 0 }
]

function grassNames() {
  return GRASSES.map(function(grass) { return grass.name })
}

// The grass a setting value names, by name or id; tall fescue when it names
// none, so a typo in shell.json still gives a working panel.
function grassFor(value) {
  var wanted = String(value || "").replace(/^\s+|\s+$/g, "").toLowerCase()
  for (var i = 0; i < GRASSES.length; i++) {
    if (GRASSES[i].name.toLowerCase() === wanted || GRASSES[i].id === wanted) return GRASSES[i]
  }
  return GRASSES[0]
}

function isWarmSeason(grassType) {
  return grassFor(grassType).warm
}

// Mowing height for display: inches as they are, or centimeters to the
// nearest half.
function mowHeight(grassType, imperial) {
  var range = grassFor(grassType).mowIn
  if (imperial) return { low: range[0], high: range[1] }
  return { low: Math.round(range[0] * 2.54 * 2) / 2, high: Math.round(range[1] * 2.54 * 2) / 2 }
}

// ---- USDA hardiness zones, "1a" to "13b". The setting is one of those, or
// "Auto" to have the zone worked out from the location's winters.

var DEFAULT_ZONE = "7a"
var AUTO_ZONE = "Auto"

function zoneOptions() {
  var out = []
  for (var n = 1; n <= 13; n++) out.push(n + "a", n + "b")
  return out
}

function isAutoZone(value) {
  var text = String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "").toLowerCase()
  return text === "" || text === "auto"
}

function normalizeZone(value) {
  var match = /^\s*(\d{1,2})\s*([ab])?\s*$/i.exec(String(value === undefined || value === null ? "" : value))
  if (!match) return DEFAULT_ZONE
  var zone = parseInt(match[1], 10) + (match[2] || "a").toLowerCase()
  return zoneOptions().indexOf(zone) === -1 ? DEFAULT_ZONE : zone
}

// 7a is 7, 7b is 7.5.
function zoneValue(value) {
  var zone = normalizeZone(value)
  return parseInt(zone, 10) + (zone.slice(-1) === "b" ? 0.5 : 0)
}

function zoneFits(grassType, zone) {
  var grass = grassFor(grassType)
  var number = Math.floor(zoneValue(zone))
  return number >= grass.zones[0] && number <= grass.zones[1]
}

// A zone is defined by the average of each year's coldest night: 10°F per
// zone from -60°F, split into a and b halves.
function zoneFromLowC(lowC) {
  if (typeof lowC !== "number" || !isFinite(lowC)) return ""
  var half = Math.floor((lowC * 9 / 5 + 32 + 60) / 5)
  half = Math.max(0, Math.min(25, half))
  return (Math.floor(half / 2) + 1) + (half % 2 === 1 ? "b" : "a")
}

// ---- Climate. Thirty years of daily lows, 1991 to 2020 (the span the USDA
// map is drawn from), give the location's zone and its usual frost dates.
// Open-Meteo's archive is a weather model rather than station records, so the
// zone can land half a zone either side of the official map.

// The model runs a little mild on still, clear nights, so a night counts as
// a frost a degree or two above freezing. These two thresholds are the ones
// that best matched NOAA's 1991-2020 freeze-date normals at eighteen stations
// in six regions of the United States: no bias on average, and typically
// within a week. Stations a few miles apart differ by more than that, so a
// yard in a hollow or by the water can still be a couple of weeks off; the
// frost dates can be set by hand for that reason.
var SPRING_FROST_C = 1
var FALL_FROST_C = 2

// Bumped when the way the climate is worked out changes, so estimates cached
// by an older version are worked out again.
var CLIMATE_VERSION = 2

function archiveUrl(location) {
  if (!hasCoordinates(location)) return ""
  return "https://archive-api.open-meteo.com/v1/archive"
    + "?latitude=" + location.latitude.toFixed(2)
    + "&longitude=" + location.longitude.toFixed(2)
    + "&start_date=1991-01-01&end_date=2020-12-31&daily=temperature_2m_min&timezone=auto"
}

// {zone, lastFrost, firstFrost} for an archive response, or null when it
// does not hold enough winters to say. The frost dates are days of the year
// (0 is January 1): the average last frost of spring and first of fall. They
// are null where frost is too rare to plan around.
function climateFromArchive(raw, southern) {
  var text = String(raw || "")
  if (text === "" || text.length > MAX_ARCHIVE_BYTES) return null
  try {
    var daily = JSON.parse(text).daily
    if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.temperature_2m_min)) return null

    var years = {}
    for (var i = 0; i < daily.time.length && i < 12000; i++) {
      var low = boundedNumber(daily.temperature_2m_min[i], -90, 60)
      if (low === null || !isDate(daily.time[i])) continue
      var key = daily.time[i].slice(0, 4)
      var year = years[key] || (years[key] = { low: low, count: 0, last: null, first: null })
      year.low = Math.min(year.low, low)
      year.count++
      if (low > FALL_FROST_C) continue

      // North of the equator the frosty season straddles New Year, so spring's
      // last frost is in the first half of the year and fall's first in the
      // second. South of it the whole season sits inside one calendar year.
      var day = dayOfYear(daily.time[i])
      var spring = (southern ? true : day < 182) && low <= SPRING_FROST_C
      var fall = southern ? true : day >= 182
      if (spring) year.last = year.last === null ? day : Math.max(year.last, day)
      if (fall) year.first = year.first === null ? day : Math.min(year.first, day)
    }

    var lowTotal = 0
    var counted = 0
    var lastTotal = 0
    var firstTotal = 0
    var frosty = 0
    for (var y in years) {
      if (years[y].count < 330) continue
      lowTotal += years[y].low
      counted++
      if (years[y].last === null || years[y].first === null) continue
      lastTotal += years[y].last
      firstTotal += years[y].first
      frosty++
    }
    if (counted < 20) return null

    var climate = { zone: zoneFromLowC(lowTotal / counted), lastFrost: null, firstFrost: null }
    // Frost in most years, and a real growing season between the two dates.
    if (frosty >= counted * 0.8) {
      var last = Math.round(lastTotal / frosty)
      var first = Math.round(firstTotal / frosty)
      var season = southern ? 365 - (last - first) : first - last
      if (season >= 60) {
        climate.lastFrost = last
        climate.firstFrost = first
      }
    }
    return climate
  } catch (e) {
    return null
  }
}

function cleanFrostDay(value) {
  return typeof value === "number" && isFinite(value) && value >= 0 && value <= 365 ? Math.round(value) : null
}

// The estimate kept between sessions:
// {"key": "lat,lon", "zone": "7a", "lastFrost": 105, "firstFrost": 297}.
function parseClimateCache(raw) {
  var empty = { key: "", zone: "", lastFrost: null, firstFrost: null }
  try {
    var data = JSON.parse(String(raw || ""))
    if (!data || typeof data !== "object") return empty
    if (data.version !== CLIMATE_VERSION) return empty
    var key = typeof data.key === "string" && /^-?\d{1,2}\.\d{2},-?\d{1,3}\.\d{2}$/.test(data.key) ? data.key : ""
    var zone = zoneOptions().indexOf(data.zone) === -1 ? "" : data.zone
    if (key === "" || zone === "") return empty
    var last = cleanFrostDay(data.lastFrost)
    var first = cleanFrostDay(data.firstFrost)
    var both = last !== null && first !== null
    return { key: key, zone: zone, lastFrost: both ? last : null, firstFrost: both ? first : null }
  } catch (e) {
    return empty
  }
}

function serialiseClimateCache(key, climate) {
  return JSON.stringify({ version: CLIMATE_VERSION, key: key, zone: climate.zone, lastFrost: climate.lastFrost, firstFrost: climate.firstFrost }) + "\n"
}

function hasFrostDates(climate) {
  return !!climate && typeof climate.lastFrost === "number" && typeof climate.firstFrost === "number"
}

// A frost date set by hand, as "MM-DD" ("04-26"), to a day of the year; null
// for anything else.
function frostSetting(value) {
  var match = /^\s*(\d{1,2})[-\/](\d{1,2})\s*$/.exec(String(value === undefined || value === null ? "" : value))
  if (!match) return null
  var date = "2026-" + (match[1].length < 2 ? "0" : "") + match[1] + "-" + (match[2].length < 2 ? "0" : "") + match[2]
  return isDate(date) ? dayOfYear(date) : null
}

// The climate the calendar uses: the estimate, with either frost date
// replaced by one set by hand. Both by hand works with no estimate at all.
function climateWith(estimate, lastSetting, firstSetting) {
  var last = frostSetting(lastSetting)
  var first = frostSetting(firstSetting)
  if (last === null && first === null) return estimate || null
  var base = estimate || { zone: "", lastFrost: null, firstFrost: null }
  var merged = { zone: base.zone, lastFrost: last !== null ? last : base.lastFrost, firstFrost: first !== null ? first : base.firstFrost }
  if (base.key !== undefined) merged.key = base.key
  return merged
}

// A frost day of the year as a date in `year`.
function frostDate(day, year) {
  return dateAfter(year + "-01-01", day)
}

// ---- The lawn calendar. Each job has two ways to place its window:
//
//   frost: days either side of the location's usual last spring frost ("LF")
//          or first fall frost ("FF"). Used whenever the frost dates are
//          known, because they are measured where the lawn actually is.
//   from/to: [month, day] for zone 7a, sliding about eight days per zone
//          (spring jobs later in a colder zone, fall jobs earlier). The
//          fallback where frost is too rare to plan around, or offline.
//
// soilC is the soil temperature the job wants, which the panel checks against
// the live reading.

var DAYS_PER_ZONE = 8

var COOL_SEASON_JOBS = [
  { id: "preEmergent", from: [3, 20], to: [4, 15], season: "spring", frost: [["LF", -30], ["LF", -5]], soilC: [10, 13] },
  { id: "springFeed", from: [5, 10], to: [6, 5], season: "spring", frost: [["LF", 25], ["LF", 50]], soilC: null },
  { id: "grubs", from: [6, 1], to: [7, 15], season: "spring", frost: [["LF", 45], ["LF", 90]], soilC: null },
  { id: "overseed", from: [8, 20], to: [9, 30], season: "fall", frost: [["FF", -75], ["FF", -45]], soilC: [10, 18], seeding: true },
  { id: "aerate", from: [8, 25], to: [10, 5], season: "fall", frost: [["FF", -65], ["FF", -25]], soilC: null },
  { id: "fallFeed", from: [9, 5], to: [10, 15], season: "fall", frost: [["FF", -50], ["FF", -10]], soilC: null },
  { id: "winterizer", from: [10, 20], to: [11, 15], season: "fall", frost: [["FF", -10], ["FF", 14]], soilC: null }
]

var WARM_SEASON_JOBS = [
  { id: "preEmergent", from: [3, 1], to: [3, 25], season: "spring", frost: [["LF", -40], ["LF", -15]], soilC: [10, 13] },
  { id: "dethatch", from: [4, 20], to: [5, 15], season: "spring", frost: [["LF", 15], ["LF", 40]], soilC: null },
  { id: "plant", from: [5, 15], to: [7, 5], season: "spring", frost: [["LF", 35], ["LF", 85]], soilC: [18, 27], seeding: true },
  { id: "summerFeed", from: [5, 15], to: [8, 15], season: "spring", frost: [["LF", 35], ["FF", -60]], soilC: null },
  { id: "aerate", from: [5, 20], to: [7, 15], season: "spring", frost: [["LF", 40], ["LF", 95]], soilC: null },
  { id: "grubs", from: [6, 1], to: [7, 15], season: "spring", frost: [["LF", 50], ["LF", 95]], soilC: null },
  { id: "fallPreEmergent", from: [9, 1], to: [9, 25], season: "fall", frost: [["FF", -70], ["FF", -45]], soilC: null }
]

function jobIds() {
  var seen = {}
  var out = []
  var jobs = COOL_SEASON_JOBS.concat(WARM_SEASON_JOBS)
  for (var i = 0; i < jobs.length; i++) {
    if (seen[jobs[i].id]) continue
    seen[jobs[i].id] = true
    out.push(jobs[i].id)
  }
  return out
}

// A window that has just closed stays on the list this long, marked as
// closed, so a job done on its last days can still be checked off and a
// missed one is not silently replaced by next year's.
var GRACE_DAYS = 21

function isoDate(year, monthDay) {
  return year + "-" + (monthDay[0] < 10 ? "0" : "") + monthDay[0] + "-" + (monthDay[1] < 10 ? "0" : "") + monthDay[1]
}

// A job's window in one year: {start, end}.
function jobWindow(job, year, grass, zone, climate, southern) {
  var seedShift = job.seeding ? grass.seedEndShift : 0
  if (hasFrostDates(climate)) {
    var anchor = function(mark) { return (mark[0] === "LF" ? climate.lastFrost : climate.firstFrost) + mark[1] }
    var from = anchor(job.frost[0])
    var to = anchor(job.frost[1]) + seedShift
    // South of the equator a window can run across New Year.
    if (to < from) to += 365
    return { start: dateAfter(year + "-01-01", from), end: dateAfter(year + "-01-01", to) }
  }
  var colder = Math.round((7 - zoneValue(zone)) * DAYS_PER_ZONE)
  var shift = (job.season === "spring" ? colder : -colder) + (southern ? 182 : 0)
  return { start: dateAfter(isoDate(year, job.from), shift), end: dateAfter(isoDate(year, job.to), shift + seedShift) }
}

// "cold", "ideal", or "warm" for a job that cares about soil temperature;
// "" when it does not, or the reading is missing.
function soilFit(job, conditions) {
  if (!job.soilC || !conditions || conditions.soilC === null) return ""
  if (conditions.soilC < job.soilC[0]) return "cold"
  return conditions.soilC > job.soilC[1] ? "warm" : "ideal"
}

// The day this job was checked off for its current window, or "". A tick
// counts from the moment the previous window dropped off the list (`since`)
// until this one does.
function doneOn(log, jobId, since, end, today) {
  var dates = log && log.done && Array.isArray(log.done[jobId]) ? log.done[jobId] : []
  var latest = dateAfter(end, GRACE_DAYS)
  for (var i = dates.length - 1; i >= 0; i--) {
    if (isDate(dates[i]) && dates[i] > since && dates[i] <= latest && dates[i] <= today) return dates[i]
  }
  return ""
}

// Checks a job off today, or unchecks it. Returns a new log.
function toggleJob(log, job, today) {
  var next = cleanLog(log)
  if (!job || jobIds().indexOf(job.id) === -1 || !isDate(today)) return next
  var dates = next.done[job.id] || []
  if (doneOn(next, job.id, job.since, job.end, today) !== "") {
    var latest = dateAfter(job.end, GRACE_DAYS)
    dates = dates.filter(function(entry) { return entry <= job.since || entry > latest })
  } else {
    dates = dates.concat([today])
  }
  if (dates.length > 0) next.done[job.id] = cleanDates(dates)
  else delete next.done[job.id]
  return next
}

// The year's jobs for this grass, each with its next window:
// {id, start, end, since, active, late, daysUntil, daysLeft, daysLate, soil,
// seeding, doneOn}. Open windows come first (the one closing soonest on top,
// those already checked off below it), then any that just closed, then the
// rest in the order they open.
function calendar(grassType, zone, today, conditions, southern, log, climate) {
  if (!isDate(today)) return []
  var grass = grassFor(grassType)
  var year = parseInt(today.slice(0, 4), 10)
  var jobs = grass.warm ? WARM_SEASON_JOBS : COOL_SEASON_JOBS

  var out = []
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i]
    for (var y = year - 1; y <= year + 1; y++) {
      var win = jobWindow(job, y, grass, zone, climate, southern)
      if (dateAfter(win.end, GRACE_DAYS) < today) continue

      var since = dateAfter(jobWindow(job, y - 1, grass, zone, climate, southern).end, GRACE_DAYS)
      var late = win.end < today
      var active = win.start <= today && !late
      out.push({
        id: job.id,
        start: win.start,
        end: win.end,
        since: since,
        active: active,
        late: late,
        daysUntil: active || late ? 0 : daysBetween(today, win.start),
        daysLeft: active ? daysBetween(today, win.end) : null,
        daysLate: late ? daysBetween(win.end, today) : null,
        soil: soilFit(job, conditions),
        seeding: job.seeding === true,
        doneOn: doneOn(log, job.id, since, win.end, today)
      })
      break
    }
  }

  out.sort(function(a, b) {
    if (a.active !== b.active) return a.active ? -1 : 1
    if (a.active && (a.doneOn === "") !== (b.doneOn === "")) return a.doneOn === "" ? -1 : 1
    if (a.active) return a.daysLeft - b.daysLeft
    if (a.late !== b.late) return a.late ? -1 : 1
    if (a.late) return a.daysLate - b.daysLate
    return a.daysUntil - b.daysUntil
  })
  return out
}

// The panel's short list: the jobs that are open and still to do, or with
// none open, the one that comes next. Everything else is a click away.
function shortCalendar(jobs) {
  var open = openJobs(jobs)
  if (open.length > 0) return open
  for (var i = 0; i < jobs.length; i++) {
    if (!jobs[i].active && !jobs[i].late) return [jobs[i]]
  }
  return []
}

// Jobs whose window is open and that are not checked off yet.
function openJobs(jobs) {
  return (jobs || []).filter(function(job) { return job.active && job.doneOn === "" })
}

// ---- Growth: how fast the grass is growing, from how well the week's
// temperatures suit it.

function ramp(value, from, to) {
  return Math.max(0, Math.min(1, (value - from) / (to - from)))
}

// 0 when it is too cold to grow, 1 in the grass's comfortable range, and
// tailing off in heat that sends it into stress.
function growthFactor(meanC, grassType) {
  if (meanC === null || meanC === undefined) return null
  if (isWarmSeason(grassType)) {
    if (meanC <= 27) return ramp(meanC, 13, 27)
    return 1 - 0.5 * ramp(meanC, 35, 42)
  }
  if (meanC <= 15) return ramp(meanC, 5, 15)
  return 1 - 0.7 * ramp(meanC, 24, 32)
}

// Below this soil temperature the grass has stopped growing.
function dormancySoilC(grassType) {
  return isWarmSeason(grassType) ? 13 : 5
}

function isDormant(conditions, today, grassType) {
  if (!conditions) return false
  var soil = conditions.soilMeanC !== null && conditions.soilMeanC !== undefined ? conditions.soilMeanC : conditions.soilC
  if (soil === null || soil === undefined) soil = meanTemp(dayFor(conditions, today))
  return soil !== null && soil < dormancySoilC(grassType)
}

// The week's average growth factor (0 stopped, 1 flat out), or null when the
// weather is unknown.
function recentGrowth(conditions, today, grassType) {
  var total = 0
  var known = 0
  for (var offset = -6; offset <= 0; offset++) {
    var factor = growthFactor(meanTemp(dayFor(conditions, dateAfter(today, offset))), grassType)
    if (factor === null) continue
    total += factor
    known++
  }
  return known > 0 ? total / known : null
}

// ---- Mowing.

// The earliest the dew is usually off, and how long grass needs after rain.
var MOW_FROM_HOUR = 9
var DRYING_HOURS = 3
var TOO_HOT_C = 32

// The next stretch of daylight that is dry and not too hot, today or
// tomorrow: {window: {dayOffset, from, to} or null, reason: "wet", "hot", or
// "" when the hourly forecast is missing}. Hours are 0 to 24, local to the
// lawn.
function mowWindow(conditions) {
  var none = { window: null, reason: "" }
  if (!conditions || !conditions.now || !conditions.hours || conditions.hours.length === 0) return none
  var nowDate = conditions.now.slice(0, 10)
  var nowHour = parseInt(conditions.now.slice(11, 13), 10)
  var hours = conditions.hours
  var wet = false
  var hot = false
  var run = null

  for (var i = 0; i < hours.length; i++) {
    var entry = hours[i]
    var dayOffset = daysBetween(nowDate, entry.date)
    if (dayOffset === null || dayOffset < 0 || dayOffset > 1 || (dayOffset === 0 && entry.hour < nowHour)) continue
    if (run && run.dayOffset !== dayOffset) break

    var day = dayFor(conditions, entry.date)
    var sunset = day && day.sunsetHour !== null ? day.sunsetHour : 18
    var daylight = entry.hour >= MOW_FROM_HOUR && entry.hour < sunset

    var rain = 0
    for (var back = Math.max(0, i - DRYING_HOURS); back <= i; back++) rain += hours[back].rainMm || 0
    var isWet = rain >= 0.1
    var isHot = entry.tempC !== null && entry.tempC >= TOO_HOT_C

    if (daylight && !isWet && !isHot) {
      if (!run) run = { dayOffset: dayOffset, from: entry.hour, to: entry.hour + 1 }
      else run.to = entry.hour + 1
      continue
    }
    if (run) break
    if (daylight && isWet) wet = true
    else if (daylight && isHot) hot = true
  }

  if (run) return { window: run, reason: "" }
  return { window: null, reason: wet ? "wet" : (hot ? "hot" : "") }
}

// What today is like for mowing: "resting" (too cold for the grass to grow,
// so nothing to mow), "today" (a dry stretch of daylight today), "tomorrow"
// (the next one is tomorrow), "wet" or "hot" (none in sight), or "" when
// there is no forecast to go on.
function mowingToday(conditions, today, grassType) {
  if (!conditions) return ""
  if (isDormant(conditions, today, grassType)) return "resting"
  var next = mowWindow(conditions)
  if (next.window) return next.window.dayOffset === 0 ? "today" : "tomorrow"
  return next.reason
}

// How fast the grass is growing, in words: "fast", "steady", "slow", "none",
// or "" when the weather is unknown.
function growthPace(conditions, today, grassType) {
  if (!conditions) return ""
  if (isDormant(conditions, today, grassType)) return "none"
  var rate = recentGrowth(conditions, today, grassType)
  if (rate === null) return ""
  if (rate >= 0.7) return "fast"
  if (rate >= 0.3) return "steady"
  return rate > 0.05 ? "slow" : "none"
}

// ---- Watering.

// The week's water balance in millimeters, from rain alone, and what to do
// about it: "resting" (the grass is barely growing, so leave the hose alone),
// "ok" (the rain has covered it), "rain" (the forecast covers the shortfall),
// "water" (give it `deficitMm`), or "" when the weather is unknown.
function waterBalance(conditions, today, grassType) {
  if (!conditions) return { needMm: null, rainMm: null, aheadMm: null, deficitMm: null, status: "" }
  var et0 = sumOver(conditions, today, "et0Mm", -6, 0)
  var rain = sumOver(conditions, today, "rainMm", -6, 0)
  var ahead = sumOver(conditions, today, "rainMm", 1, 3)
  var need = et0 !== null ? et0 * TURF_COEFFICIENT : null
  var deficit = need !== null ? Math.max(0, need - (rain || 0)) : null

  var status = ""
  var growing = recentGrowth(conditions, today, grassType)
  if (isDormant(conditions, today, grassType) || (growing !== null && growing < 0.2)) status = "resting"
  else if (deficit === null) status = ""
  else if (deficit < 3) status = "ok"
  else if ((ahead || 0) >= deficit) status = "rain"
  else status = "water"

  return { needMm: need, rainMm: rain, aheadMm: ahead, deficitMm: deficit, status: status }
}

// ---- Alerts: the things worth a nudge, each with a key that stays the same
// for as long as it is the same event, so it is only announced once.

function alerts(jobs) {
  return openJobs(jobs).map(function(job) { return { key: "job:" + job.id + ":" + job.start, id: job.id } })
}

function isAlertKey(value) {
  return typeof value === "string" && /^job:[A-Za-z0-9:-]{1,60}$/.test(value)
}

// The keys already announced, oldest first.
function parseNotified(raw) {
  try {
    var data = JSON.parse(String(raw || ""))
    if (!Array.isArray(data)) return []
    return data.filter(isAlertKey).slice(-MAX_NOTIFIED)
  } catch (e) {
    return []
  }
}

function serialiseNotified(keys) {
  return JSON.stringify((keys || []).filter(isAlertKey).slice(-MAX_NOTIFIED)) + "\n"
}

// Text for a notification, which renders markup: control characters dropped,
// markup characters escaped, and the length bounded.
function plainText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 200)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// ---- Units.

function usesImperial(localeName) {
  var name = String(localeName || "").replace(".", "_")
  return /^en[_-]US($|[_.-])/.test(name) || /^en[_-]LR($|[_.-])/.test(name) || /^my($|[_.-])/.test(name)
}

// {value, decimals} for a rainfall depth: inches to two places, or whole
// millimeters (one place under 10 mm).
function depth(mm, imperial) {
  if (mm === null || mm === undefined) return null
  if (imperial) return { value: mm / 25.4, decimals: 2 }
  return { value: mm, decimals: mm < 10 && mm > 0 ? 1 : 0 }
}

function temperature(celsius, imperial) {
  if (celsius === null || celsius === undefined) return null
  return Math.round(imperial ? celsius * 9 / 5 + 32 : celsius)
}

if (typeof module !== "undefined") {
  module.exports = {
    MAX_LOG_ENTRIES: MAX_LOG_ENTRIES,
    MAX_FORECAST_DAYS: MAX_FORECAST_DAYS,
    MAX_FORECAST_HOURS: MAX_FORECAST_HOURS,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    MAX_ARCHIVE_BYTES: MAX_ARCHIVE_BYTES,
    MAX_SUGGESTIONS: MAX_SUGGESTIONS,
    MAX_NOTIFIED: MAX_NOTIFIED,
    DEFAULT_ZONE: DEFAULT_ZONE,
    AUTO_ZONE: AUTO_ZONE,
    GRACE_DAYS: GRACE_DAYS,
    GRASSES: GRASSES,
    isDate: isDate,
    daysBetween: daysBetween,
    dateAfter: dateAfter,
    dayOfYear: dayOfYear,
    cleanLog: cleanLog,
    parseLog: parseLog,
    serialiseLog: serialiseLog,
    cleanName: cleanName,
    cleanLocation: cleanLocation,
    parseLocation: parseLocation,
    hasCoordinates: hasCoordinates,
    storedLocation: storedLocation,
    pickLocation: pickLocation,
    locationKey: locationKey,
    geocodeUrl: geocodeUrl,
    parseGeocoding: parseGeocoding,
    forecastUrl: forecastUrl,
    parseConditions: parseConditions,
    sumOver: sumOver,
    grassNames: grassNames,
    grassFor: grassFor,
    isWarmSeason: isWarmSeason,
    mowHeight: mowHeight,
    zoneOptions: zoneOptions,
    isAutoZone: isAutoZone,
    normalizeZone: normalizeZone,
    zoneValue: zoneValue,
    zoneFits: zoneFits,
    zoneFromLowC: zoneFromLowC,
    archiveUrl: archiveUrl,
    climateFromArchive: climateFromArchive,
    parseClimateCache: parseClimateCache,
    serialiseClimateCache: serialiseClimateCache,
    hasFrostDates: hasFrostDates,
    frostSetting: frostSetting,
    climateWith: climateWith,
    frostDate: frostDate,
    jobIds: jobIds,
    jobWindow: jobWindow,
    soilFit: soilFit,
    doneOn: doneOn,
    toggleJob: toggleJob,
    calendar: calendar,
    shortCalendar: shortCalendar,
    openJobs: openJobs,
    growthFactor: growthFactor,
    dormancySoilC: dormancySoilC,
    isDormant: isDormant,
    recentGrowth: recentGrowth,
    mowWindow: mowWindow,
    mowingToday: mowingToday,
    growthPace: growthPace,
    waterBalance: waterBalance,
    alerts: alerts,
    parseNotified: parseNotified,
    serialiseNotified: serialiseNotified,
    plainText: plainText,
    usesImperial: usesImperial,
    depth: depth,
    temperature: temperature
  }
}
