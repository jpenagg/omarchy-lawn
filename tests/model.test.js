// Run with: node --test ~/.config/omarchy/plugins/jpenagg.lawn/tests/
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.join(__dirname, "..")
const Model = require(path.join(root, "Model.js"))

const MARKUP = '<img src="https://example.invalid/tracker">'
const EMPTY_LOG = { done: {} }
// A zone 7a sort of place: last frost about Apr 18, first about Oct 24.
const CLIMATE = { zone: "7a", lastFrost: 107, firstFrost: 296 }

// A forecast around 2026-06-15 at 10:00: fourteen past days, today, three
// ahead, and hourly values from a day back to forty hours on. Mild, dry, and
// light until 8 pm unless overridden.
function weather(overrides, hourOverrides) {
  const time = []
  for (let offset = -14; offset <= 3; offset++) time.push(Model.dateAfter("2026-06-15", offset))
  const fill = (value) => time.map(() => value)

  const hourTime = []
  for (let h = -24; h < 40; h++) {
    const day = Model.dateAfter("2026-06-15", Math.floor((10 + h) / 24))
    const hour = (((10 + h) % 24) + 24) % 24
    hourTime.push(day + "T" + String(hour).padStart(2, "0") + ":00")
  }
  const hourly = Object.assign({
    time: hourTime,
    precipitation: hourTime.map(() => 0),
    temperature_2m: hourTime.map(() => 20),
    soil_temperature_6cm: hourTime.map(() => 17)
  }, hourOverrides ? hourOverrides(hourTime) : {})

  return JSON.stringify(Object.assign({
    current: { time: "2026-06-15T10:00", temperature_2m: 20, precipitation: 0, soil_temperature_6cm: 17 },
    hourly,
    daily: {
      time,
      precipitation_sum: fill(0),
      et0_fao_evapotranspiration: fill(4),
      temperature_2m_max: fill(24),
      temperature_2m_min: fill(14),
      sunset: time.map((date) => date + "T20:30")
    }
  }, overrides || {}))
}

const daily = (changes) => ({ daily: Object.assign(JSON.parse(weather()).daily, changes(JSON.parse(weather()).daily.time)) })

// ---- Dates.

test("dates are validated strictly", () => {
  assert.equal(Model.isDate("2026-02-28"), true)
  assert.equal(Model.isDate("2026-02-30"), false)
  assert.equal(Model.isDate("2026-13-01"), false)
  assert.equal(Model.isDate("2026-1-1"), false)
  assert.equal(Model.isDate(MARKUP), false)
  assert.equal(Model.isDate(20260101), false)
  assert.equal(Model.daysBetween("2026-12-30", "2027-01-02"), 3)
  assert.equal(Model.dateAfter("2026-12-30", 3), "2027-01-02")
  assert.equal(Model.dateAfter("2026-03-01", -1), "2026-02-28")
  assert.equal(Model.dayOfYear("2026-01-01"), 0)
  assert.equal(Model.dayOfYear("2026-12-31"), 364)
})

// ---- Location and town search.

test("a location is reduced to a bounded plain name and valid coordinates", () => {
  const loc = Model.parseLocation(JSON.stringify({ name: "  Spring\nfield\u0007 ", latitude: 39.8, longitude: "-89.65" }))
  assert.deepEqual(loc, { name: "Spring field", latitude: 39.8, longitude: -89.65 })

  const long = Model.parseLocation(JSON.stringify({ name: "x".repeat(500), latitude: 1, longitude: 2 }))
  assert.equal(long.name.length, Model.MAX_NAME_LENGTH)

  for (const bad of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: "1e3", longitude: 0 },
    { latitude: "12; rm -rf", longitude: 0 }, { latitude: null, longitude: 0 }, { latitude: [1], longitude: 0 }]) {
    assert.equal(Model.hasCoordinates(Model.parseLocation(JSON.stringify(bad))), false)
  }
  assert.equal(Model.hasCoordinates(Model.parseLocation("not json")), false)
  assert.equal(Model.parseLocation(JSON.stringify({ name: { toString: 1 } })).name, "")
})

test("markup in a place name stays text and never reaches a request", () => {
  // The name is display-only (shown through PlainText); requests are built
  // from the numeric coordinates alone.
  const loc = Model.parseLocation(JSON.stringify({ name: MARKUP, latitude: 40.123456, longitude: -74.987654 }))
  assert.equal(loc.name, MARKUP)
  const url = Model.forecastUrl(loc)
  assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=40\.12&longitude=-74\.99&/)
  assert.equal(url.includes("<"), false)
  assert.equal(Model.forecastUrl({ name: "Nowhere", latitude: null, longitude: null }), "")
})

test("the lawn's own location wins, then the weather widget's, then the network's", () => {
  const own = { name: "Lawn", latitude: 40.123456, longitude: -74.987654 }
  const weatherLoc = { name: "Weather", latitude: 1, longitude: 2 }
  const network = { name: "Network", latitude: 3, longitude: 4 }
  const none = { name: "", latitude: null, longitude: null }
  assert.equal(Model.pickLocation(own, weatherLoc, network).source, "own")
  assert.equal(Model.pickLocation(none, weatherLoc, network).name, "Weather")
  assert.equal(Model.pickLocation(Model.cleanLocation(null), none, network).source, "network")
  assert.deepEqual(Model.pickLocation(none, none, none), { name: "", latitude: null, longitude: null, source: "none" })

  // Saved with coordinates rounded to about a kilometer.
  assert.deepEqual(Model.storedLocation(own), { name: "Lawn", latitude: 40.12, longitude: -74.99 })
  assert.equal(Model.storedLocation({ name: "Nowhere" }), null)
  assert.equal(Model.storedLocation(undefined), null)
  assert.equal(Model.locationKey(own), "40.12,-74.99")
  assert.equal(Model.locationKey(none), "")
})

test("town search results are bounded and stay plain text", () => {
  assert.equal(Model.geocodeUrl("a"), "")
  assert.equal(Model.geocodeUrl("Spring field"), "https://geocoding-api.open-meteo.com/v1/search?name=Spring%20field&count=5&language=en&format=json")
  const hostile = Model.geocodeUrl('x&count=999" ; rm -rf ~ #' + "y".repeat(500))
  assert.match(hostile, /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=[A-Za-z0-9%~.-]+&count=5&language=en&format=json$/)
  assert.ok(hostile.length < 400)

  const results = []
  for (let i = 0; i < 20; i++) results.push({ name: "Town " + i, admin1: "State", country: "Country", latitude: 40 + i, longitude: -74 })
  results.unshift({ name: MARKUP, admin1: MARKUP, country: "x".repeat(300), latitude: 1, longitude: 2 }, { name: "No coordinates" }, { name: "", latitude: 1, longitude: 2 }, null)
  const parsed = Model.parseGeocoding(JSON.stringify({ results }))
  assert.equal(parsed.length, Model.MAX_SUGGESTIONS)
  assert.equal(parsed[0].name, MARKUP)
  assert.ok(parsed[0].description.length <= 2 * Model.MAX_NAME_LENGTH + 2)
  assert.deepEqual(parsed[1], { name: "Town 0", description: "State, Country", latitude: 40, longitude: -74 })
  assert.deepEqual(Model.parseGeocoding("{}"), [])
  assert.deepEqual(Model.parseGeocoding("<html>"), [])
  assert.deepEqual(Model.parseGeocoding(JSON.stringify({ results: "x" })), [])
})

// ---- Weather.

test("the weather response is validated and bounded", () => {
  const parsed = Model.parseConditions(weather())
  assert.equal(parsed.now, "2026-06-15T10:00")
  assert.equal(parsed.soilC, 17)
  assert.equal(parsed.soilMeanC, 17)
  assert.equal(parsed.days.length, 18)
  assert.equal(parsed.days[0].date, "2026-06-01")
  assert.equal(parsed.days[0].sunsetHour, 20)
  assert.equal(parsed.hours.length, 64)
  assert.deepEqual(parsed.hours[24], { date: "2026-06-15", hour: 10, rainMm: 0, tempC: 20 })

  assert.equal(Model.parseConditions(""), null)
  assert.equal(Model.parseConditions("<html>"), null)
  assert.equal(Model.parseConditions(JSON.stringify({ daily: { time: "x" } })), null)
  assert.equal(Model.parseConditions("x".repeat(Model.MAX_RESPONSE_BYTES + 1)), null)

  const hostile = Model.parseConditions(JSON.stringify({
    current: { time: MARKUP, soil_temperature_6cm: MARKUP, temperature_2m: 9999, precipitation: -5 },
    hourly: { time: ["2026-06-15T10:00", MARKUP, "2026-06-15T99:00"], precipitation: [MARKUP], temperature_2m: "x", soil_temperature_6cm: [{}] },
    daily: {
      time: ["2026-06-15", MARKUP, "2026-06-16"],
      precipitation_sum: [MARKUP, 1, 1e9],
      et0_fao_evapotranspiration: [null, 1, 2],
      temperature_2m_max: ["NaN", 1, 20],
      temperature_2m_min: [{}, 1, 10],
      sunset: [MARKUP, MARKUP, "2026-06-16T20:15"]
    }
  }))
  assert.equal(hostile.now, "")
  assert.equal(hostile.soilC, null)
  assert.equal(hostile.soilMeanC, null)
  assert.equal(hostile.airC, null)
  assert.equal(hostile.rainingMm, null)
  assert.deepEqual(hostile.days.map((d) => d.date), ["2026-06-15", "2026-06-16"])
  assert.deepEqual(hostile.days[0], { date: "2026-06-15", rainMm: null, et0Mm: null, maxC: null, minC: null, sunsetHour: null })
  assert.equal(hostile.days[1].rainMm, null)
  assert.equal(hostile.days[1].sunsetHour, 20)
  assert.deepEqual(hostile.hours, [{ date: "2026-06-15", hour: 10, rainMm: null, tempC: null }])

  const time = []
  for (let i = 0; i < 500; i++) time.push(Model.dateAfter("2026-01-01", i))
  const hourTime = time.map((date) => date + "T12:00")
  const big = Model.parseConditions(JSON.stringify({ daily: { time }, hourly: { time: hourTime } }))
  assert.equal(big.days.length, Model.MAX_FORECAST_DAYS)
  assert.equal(big.hours.length, Model.MAX_FORECAST_HOURS)
})

// ---- Grasses and zones.

test("grass types resolve by name or id and fall back to tall fescue", () => {
  assert.equal(Model.grassFor("Kentucky bluegrass").id, "kentucky-bluegrass")
  assert.equal(Model.grassFor("  PERENNIAL RYEGRASS ").id, "perennial-ryegrass")
  assert.equal(Model.grassFor("bermuda").warm, true)
  assert.equal(Model.grassFor(MARKUP).id, "tall-fescue")
  assert.equal(Model.grassFor(undefined).id, "tall-fescue")
  assert.equal(Model.isWarmSeason("Zoysia"), true)
  assert.equal(Model.isWarmSeason("Tall fescue"), false)
  assert.deepEqual(Model.mowHeight("Tall fescue", true), { low: 3, high: 4 })
  assert.deepEqual(Model.mowHeight("Tall fescue", false), { low: 7.5, high: 10 })
})

test("zones normalize, and anything else is the default", () => {
  assert.equal(Model.normalizeZone("7B"), "7b")
  assert.equal(Model.normalizeZone(" 6 "), "6a")
  assert.equal(Model.normalizeZone("12a"), "12a")
  assert.equal(Model.normalizeZone("14a"), "7a")
  assert.equal(Model.normalizeZone(MARKUP), "7a")
  assert.equal(Model.normalizeZone(undefined), "7a")
  assert.equal(Model.zoneValue("7b"), 7.5)
  assert.equal(Model.zoneOptions().length, 26)
  assert.equal(Model.isAutoZone(""), true)
  assert.equal(Model.isAutoZone(" auto "), true)
  assert.equal(Model.isAutoZone(undefined), true)
  assert.equal(Model.isAutoZone("7a"), false)
  assert.equal(Model.zoneFits("Kentucky bluegrass", "7b"), true)
  assert.equal(Model.zoneFits("Kentucky bluegrass", "9a"), false)
  assert.equal(Model.zoneFits("St. Augustine", "6b"), false)
})

// ---- Climate: the zone and frost dates from thirty years of lows.

// Daily lows for `years` years from 1991. `low(dayOfYear, yearIndex)` gives
// each day's value.
function archive(years, low) {
  const time = []
  const lows = []
  for (let y = 0; y < years; y++) {
    for (let d = 0; d < 365; d++) {
      time.push(Model.dateAfter((1991 + y) + "-01-01", d))
      lows.push(low(d, y))
    }
  }
  return JSON.stringify({ daily: { time, temperature_2m_min: lows } })
}

test("the zone comes from the average of each year's coldest night", () => {
  // 0 to 5 F is 7a, 5 to 10 F is 7b.
  assert.equal(Model.zoneFromLowC((2 - 32) * 5 / 9), "7a")
  assert.equal(Model.zoneFromLowC((7 - 32) * 5 / 9), "7b")
  assert.equal(Model.zoneFromLowC((-22 - 32) * 5 / 9), "4b")
  assert.equal(Model.zoneFromLowC((42 - 32) * 5 / 9), "11a")
  assert.equal(Model.zoneFromLowC(-200), "1a")
  assert.equal(Model.zoneFromLowC(200), "13b")
  assert.equal(Model.zoneFromLowC(NaN), "")
  assert.equal(Model.zoneFromLowC(MARKUP), "")

  // One coldest night a year, alternating -14 C and -18 C: average -16 C,
  // which is 3.2 F, zone 7a.
  assert.equal(Model.climateFromArchive(archive(30, (d, y) => (d === 20 ? (y % 2 ? -14 : -18) : 10)), false).zone, "7a")
  assert.equal(Model.climateFromArchive(archive(30, (d) => (d === 20 ? -30 : 10)), false).zone, "4b")
})

test("frost dates are the average last frost of spring and first of fall", () => {
  // Frosty until day 100 and from day 300 on, every year.
  const north = Model.climateFromArchive(archive(30, (d) => (d <= 100 || d >= 300 ? -5 : 12)), false)
  assert.deepEqual(north, { zone: "9a", lastFrost: 100, firstFrost: 300 })

  // It varies year to year: the average is what counts.
  const varied = Model.climateFromArchive(archive(30, (d, y) => (d <= 95 + (y % 3) * 5 || d >= 300 ? -5 : 12)), false)
  assert.equal(varied.lastFrost, 100)

  // South of the equator the frosty season sits mid-year.
  const south = Model.climateFromArchive(archive(30, (d) => (d >= 140 && d <= 260 ? -2 : 12)), true)
  assert.deepEqual([south.firstFrost, south.lastFrost], [140, 260])

  // The model runs mild, so a night just above freezing counts: up to 1 C in
  // spring and 2 C in fall, the thresholds that matched NOAA's normals best.
  const marginal = Model.climateFromArchive(archive(30, (d) => (d <= 90 ? 0.5 : d <= 100 ? 1.5 : d >= 300 ? 1.5 : 12)), false)
  assert.deepEqual([marginal.lastFrost, marginal.firstFrost], [90, 300])

  // Frost-free, or frost in only a few years: a zone but no dates to plan by.
  assert.deepEqual(Model.climateFromArchive(archive(30, () => 15), false), { zone: "12b", lastFrost: null, firstFrost: null })
  const rare = Model.climateFromArchive(archive(30, (d, y) => (y < 5 && (d < 10 || d > 355) ? -1 : 8)), false)
  assert.equal(rare.lastFrost, null)

  // Too few winters, junk, or too much of it: nothing at all.
  assert.equal(Model.climateFromArchive(archive(10, () => -16), false), null)
  assert.equal(Model.climateFromArchive("", false), null)
  assert.equal(Model.climateFromArchive("<html>", false), null)
  assert.equal(Model.climateFromArchive(JSON.stringify({ daily: { time: [MARKUP], temperature_2m_min: [MARKUP] } }), false), null)
  assert.equal(Model.climateFromArchive("x".repeat(Model.MAX_ARCHIVE_BYTES + 1), false), null)
  assert.match(Model.archiveUrl({ latitude: 40.123456, longitude: -74.987654 }), /^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?latitude=40\.12&longitude=-74\.99&start_date=1991-01-01&end_date=2020-12-31&/)
  assert.equal(Model.archiveUrl({ latitude: null, longitude: null }), "")
  assert.equal(Model.frostDate(107, 2026), "2026-04-18")
})

test("the climate cache only accepts a coordinate key, a real zone, and sane frost days", () => {
  const cached = Model.parseClimateCache(Model.serialiseClimateCache("40.12,-74.99", CLIMATE))
  assert.deepEqual(cached, { key: "40.12,-74.99", zone: "7a", lastFrost: 107, firstFrost: 296 })
  // An estimate cached by an older version is thrown away and worked out again.
  assert.equal(Model.parseClimateCache(JSON.stringify({ key: "40.12,-74.99", zone: "7a", lastFrost: 107, firstFrost: 296 })).key, "")
  assert.equal(Model.hasFrostDates(cached), true)

  const empty = { key: "", zone: "", lastFrost: null, firstFrost: null }
  assert.deepEqual(Model.parseClimateCache(JSON.stringify({ version: 2, key: MARKUP, zone: "7a" })), empty)
  assert.deepEqual(Model.parseClimateCache(JSON.stringify({ version: 2, key: "40.12,-74.99", zone: MARKUP })), empty)
  assert.deepEqual(Model.parseClimateCache(JSON.stringify({ version: 2, key: "40.12,-74.99", zone: "Auto" })), empty)
  assert.deepEqual(Model.parseClimateCache("nope"), empty)

  // A zone with no usable frost dates is still a zone.
  const half = Model.parseClimateCache(JSON.stringify({ version: 2, key: "40.12,-74.99", zone: "10a", lastFrost: MARKUP, firstFrost: 300 }))
  assert.deepEqual(half, { key: "40.12,-74.99", zone: "10a", lastFrost: null, firstFrost: null })
  assert.equal(Model.hasFrostDates(half), false)
  assert.equal(Model.parseClimateCache(JSON.stringify({ version: 2, key: "40.12,-74.99", zone: "7a", lastFrost: 9999, firstFrost: 300 })).firstFrost, null)
})

// ---- The calendar.

const find = (jobs, id) => jobs.find((job) => job.id === id)

test("frost dates can be set by hand", () => {
  assert.equal(Model.frostSetting("04-26"), 115)
  assert.equal(Model.frostSetting(" 4/26 "), 115)
  assert.equal(Model.frostSetting("10-18"), 290)
  for (const bad of ["", "13-01", "02-30", "April 26", MARKUP, null, undefined, 426]) assert.equal(Model.frostSetting(bad), null)

  // Nothing set: the estimate as it is.
  assert.equal(Model.climateWith(CLIMATE, "", ""), CLIMATE)
  assert.equal(Model.climateWith(null, "", ""), null)
  // One or both set: they win, and the zone is kept.
  assert.deepEqual(Model.climateWith(CLIMATE, "04-26", ""), { zone: "7a", lastFrost: 115, firstFrost: 296 })
  assert.deepEqual(Model.climateWith(CLIMATE, "04-26", "10-18"), { zone: "7a", lastFrost: 115, firstFrost: 290 })
  // Both set works offline, with no estimate at all.
  const offline = Model.climateWith(null, "04-26", "10-18")
  assert.equal(Model.hasFrostDates(offline), true)
  // The seeding window then closes 45 days before the first frost and opens 30 days before that.
  const seed = find(Model.calendar("Tall fescue", "7a", "2026-01-15", null, false, EMPTY_LOG, offline), "overseed")
  assert.deepEqual([seed.start, seed.end], ["2026-08-04", "2026-09-03"])
  // Only one set and nothing to fill in the other: back to the zone.
  assert.equal(Model.hasFrostDates(Model.climateWith(null, "04-26", "")), false)
})

test("with frost dates, the calendar hangs each job off them", () => {
  const jobs = Model.calendar("Tall fescue", "7a", "2026-01-15", null, false, EMPTY_LOG, CLIMATE)
  // Pre-emergent runs up to the last frost. Seeding closes 45 days before the
  // first fall frost and opens 30 days before that.
  assert.deepEqual([find(jobs, "preEmergent").start, find(jobs, "preEmergent").end], ["2026-03-19", "2026-04-13"])
  assert.deepEqual([find(jobs, "overseed").start, find(jobs, "overseed").end], ["2026-08-10", "2026-09-09"])
  assert.deepEqual([find(jobs, "winterizer").start, find(jobs, "winterizer").end], ["2026-10-14", "2026-11-07"])
  assert.equal(jobs.length, 7)

  // The zone no longer moves the dates: the frosts are measured where the lawn is.
  const other = Model.calendar("Tall fescue", "4a", "2026-01-15", null, false, EMPTY_LOG, CLIMATE)
  assert.equal(find(other, "overseed").start, "2026-08-10")

  // A later spring and an earlier fall move both ends.
  const colder = Model.calendar("Tall fescue", "5a", "2026-01-15", null, false, EMPTY_LOG, { zone: "5a", lastFrost: 125, firstFrost: 278 })
  assert.equal(find(colder, "preEmergent").start, "2026-04-06")
  assert.equal(find(colder, "overseed").start, "2026-07-23")

  // Slow bluegrass has to be down earlier; quick ryegrass has longer.
  assert.equal(find(Model.calendar("Kentucky bluegrass", "7a", "2026-01-15", null, false, EMPTY_LOG, CLIMATE), "overseed").end, "2026-08-30")
  assert.equal(find(Model.calendar("Perennial ryegrass", "7a", "2026-01-15", null, false, EMPTY_LOG, CLIMATE), "overseed").end, "2026-09-16")

  // Warm-season grass is planted going into summer, and fed until two months before frost.
  const bermuda = Model.calendar("Bermuda", "8a", "2026-01-15", null, false, EMPTY_LOG, { zone: "8a", lastFrost: 87, firstFrost: 312 })
  assert.equal(find(bermuda, "overseed"), undefined)
  assert.equal(find(bermuda, "plant").start, "2026-05-03")
  assert.equal(find(bermuda, "summerFeed").end, "2026-09-10")

  // South of the equator fall seeding lands in March.
  const south = Model.calendar("Tall fescue", "9a", "2026-01-15", null, true, EMPTY_LOG, { zone: "9a", lastFrost: 280, firstFrost: 130 })
  assert.equal(find(south, "overseed").start, "2026-02-25")
  for (const job of south) assert.ok(job.start <= job.end, job.id)
})

test("without frost dates, the calendar slides with the zone", () => {
  const at = (grass, zone) => Model.calendar(grass, zone, "2026-01-15", null, false, EMPTY_LOG, null)

  // Colder: spring later, fall earlier. Warmer: the reverse.
  assert.equal(find(at("Tall fescue", "7a"), "preEmergent").start, "2026-03-20")
  assert.equal(find(at("Tall fescue", "5a"), "preEmergent").start, "2026-04-05")
  assert.equal(find(at("Tall fescue", "5a"), "overseed").start, "2026-08-04")
  assert.equal(find(at("Tall fescue", "7b"), "overseed").start, "2026-08-24")
  assert.equal(find(at("Kentucky bluegrass", "7a"), "overseed").end, "2026-09-20")
  assert.equal(find(at("Bermuda", "8a"), "plant").start, "2026-05-07")

  // A zone with no frost dates (frost-free places) falls back the same way.
  const frostFree = Model.calendar("Bermuda", "10a", "2026-01-15", null, false, EMPTY_LOG, { zone: "10a", lastFrost: null, firstFrost: null })
  assert.equal(find(frostFree, "plant").start, find(at("Bermuda", "10a"), "plant").start)

  const south = Model.calendar("Tall fescue", "7a", "2026-01-15", null, true, EMPTY_LOG, null)
  assert.equal(find(south, "overseed").start, "2026-02-18")
  assert.deepEqual(Model.calendar("Tall fescue", "7a", "garbage", null, false, EMPTY_LOG, null), [])
})

test("seeding jobs read the soil temperature", () => {
  const soil = (soilC) => find(Model.calendar("Tall fescue", "7a", "2026-09-01", { soilC, days: [] }, false, EMPTY_LOG, null), "overseed").soil
  assert.equal(soil(15), "ideal")
  assert.equal(soil(24), "warm")
  assert.equal(soil(6), "cold")
  assert.equal(soil(null), "")
  assert.equal(find(Model.calendar("Tall fescue", "7a", "2026-09-01", { soilC: 15, days: [] }, false, EMPTY_LOG, null), "aerate").soil, "")
})

test("the mowing window is the next dry stretch of daylight", () => {
  // Dry all day: from now (10 am) until sunset at 8 pm.
  assert.deepEqual(Model.mowWindow(Model.parseConditions(weather())), { window: { dayOffset: 0, from: 10, to: 20 }, reason: "" })

  const hoursWhere = (test, values) => (time) => {
    const out = {}
    for (const field in values) out[field] = time.map((stamp) => (test(stamp.slice(0, 10), parseInt(stamp.slice(11, 13), 10)) ? values[field][0] : values[field][1]))
    return out
  }

  // Rain until noon today: the grass needs three more hours to dry.
  const morningRain = Model.parseConditions(weather(null, hoursWhere((date, hour) => date === "2026-06-15" && hour < 12, { precipitation: [1, 0] })))
  assert.deepEqual(Model.mowWindow(morningRain).window, { dayOffset: 0, from: 15, to: 20 })

  // A shower at 3 pm cuts the window short.
  const shower = Model.parseConditions(weather(null, hoursWhere((date, hour) => date === "2026-06-15" && hour === 15, { precipitation: [2, 0] })))
  assert.deepEqual(Model.mowWindow(shower).window, { dayOffset: 0, from: 10, to: 15 })

  // Rain all of today: tomorrow, once the dew is off.
  const wetToday = Model.parseConditions(weather(null, hoursWhere((date) => date <= "2026-06-15", { precipitation: [1, 0] })))
  assert.deepEqual(Model.mowWindow(wetToday).window, { dayOffset: 1, from: 9, to: 20 })

  // Rain both days, or heat through the daylight hours: no window.
  const soaked = Model.parseConditions(weather(null, hoursWhere(() => true, { precipitation: [1, 0] })))
  assert.deepEqual(Model.mowWindow(soaked), { window: null, reason: "wet" })
  const heat = Model.parseConditions(weather(null, hoursWhere((date, hour) => hour >= 9 && hour < 20, { temperature_2m: [35, 24] })))
  assert.deepEqual(Model.mowWindow(heat), { window: null, reason: "hot" })

  // After dark: tomorrow.
  const night = Model.parseConditions(weather({ current: { time: "2026-06-15T21:00", soil_temperature_6cm: 17 } }))
  assert.equal(Model.mowWindow(night).window.dayOffset, 1)

  // No hourly forecast: nothing to say.
  assert.deepEqual(Model.mowWindow(null), { window: null, reason: "" })
  assert.deepEqual(Model.mowWindow(Model.parseConditions(weather({ hourly: null }))), { window: null, reason: "" })
})

test("notification text has its markup neutralized", () => {
  assert.equal(Model.plainText(MARKUP), "&lt;img src=\"https://example.invalid/tracker\"&gt;")
  assert.equal(Model.plainText("Seed & feed"), "Seed &amp; feed")
  assert.equal(Model.plainText("line\nbreak\u0007"), "line break ")
  assert.equal(Model.plainText(null), "")
  assert.ok(Model.plainText("<".repeat(1000)).length <= 800)
  assert.equal(/[<>]/.test(Model.plainText("<b>" + "x".repeat(500) + "</b>")), false)
})

// ---- The log.

test("the log keeps only known jobs and clean dates", () => {
  const log = Model.parseLog(JSON.stringify({
    done: { overseed: ["2026-09-01", "2026-09-01", MARKUP, 7, "2026-99-99"], [MARKUP]: ["2026-09-01"], aerate: "x" },
    mowed: ["2026-06-01"],
    extra: MARKUP
  }))
  assert.deepEqual(log, { done: { overseed: ["2026-09-01"] } })
  assert.deepEqual(Model.parseLog(Model.serialiseLog(log)), log)
  assert.deepEqual(Model.parseLog("{broken"), EMPTY_LOG)
  assert.deepEqual(Model.parseLog("[]"), EMPTY_LOG)
  assert.deepEqual(Model.parseLog(""), EMPTY_LOG)

  const many = []
  for (let i = 0; i < 1000; i++) many.push(Model.dateAfter("2020-01-01", i))
  assert.equal(Model.parseLog(JSON.stringify({ done: { overseed: many } })).done.overseed.length, Model.MAX_LOG_ENTRIES)
})

test("open windows come first, then just-closed ones, then what is next", () => {
  const jobs = Model.calendar("Tall fescue", "7a", "2026-09-01", null, false, EMPTY_LOG, null)
  const seed = find(jobs, "overseed")
  assert.deepEqual([seed.start, seed.end, seed.active, seed.daysLeft], ["2026-08-20", "2026-09-30", true, 29])
  assert.equal(jobs[0].active, true)
  const upcoming = jobs.filter((job) => !job.active && !job.late).map((job) => job.daysUntil)
  assert.deepEqual(upcoming, upcoming.slice().sort((a, b) => a - b))
  assert.deepEqual(Model.openJobs(jobs).map((job) => job.id).sort(), ["aerate", "overseed"])

  // The winterizer window ended Nov 15: it stays on the list for three weeks.
  const late = Model.calendar("Tall fescue", "7a", "2026-11-24", null, false, EMPTY_LOG, null)
  assert.deepEqual([late[0].id, late[0].late, late[0].active, late[0].daysLate, late[0].start], ["winterizer", true, false, 9, "2026-10-20"])
  assert.equal(late[1].id, "preEmergent")
  assert.equal(late[1].start, "2027-03-20")

  const gone = Model.calendar("Tall fescue", "7a", "2026-12-20", null, false, EMPTY_LOG, null)
  assert.equal(gone.every((job) => !job.active && !job.late), true)
  assert.equal(find(gone, "winterizer").start, "2027-10-20")
})

test("the short list is what is open, or else the one job that is next", () => {
  const at = (today, log, grass) => Model.calendar(grass || "Tall fescue", "7a", today, null, false, log || EMPTY_LOG, null)
  const ids = (jobs) => Model.shortCalendar(jobs).map((job) => job.id)

  // Nothing open: just the next one, even with a job that closed last week.
  assert.deepEqual(ids(at("2026-11-24")), ["preEmergent"])
  assert.deepEqual(ids(at("2026-12-20")), ["preEmergent"])
  assert.deepEqual(ids(at("2026-12-20", null, "Bermuda")), ["preEmergent"])
  // Early fall, when three windows overlap: all three, soonest to close first.
  assert.deepEqual(ids(at("2026-09-10")), ["overseed", "aerate", "fallFeed"])
  // One of them ticked off drops out; all of them ticked leaves what is next.
  const seeded = Model.toggleJob(EMPTY_LOG, find(at("2026-09-10"), "overseed"), "2026-09-10")
  assert.deepEqual(ids(at("2026-09-10", seeded)), ["aerate", "fallFeed"])
  let all = seeded
  for (const id of ["aerate", "fallFeed"]) all = Model.toggleJob(all, find(at("2026-09-10", all), id), "2026-09-10")
  assert.deepEqual(ids(at("2026-09-10", all)), ["winterizer"])
  assert.deepEqual(Model.shortCalendar([]), [])
})

test("a job is checked off for its window, and the next year starts unchecked", () => {
  const at = (today, log) => Model.calendar("Tall fescue", "7a", today, null, false, log, null)

  let log = Model.toggleJob(EMPTY_LOG, find(at("2026-09-01", EMPTY_LOG), "overseed"), "2026-09-01")
  assert.deepEqual(log.done, { overseed: ["2026-09-01"] })
  const done = at("2026-09-05", log)
  assert.equal(find(done, "overseed").doneOn, "2026-09-01")
  // Still-to-do jobs that are open sort above the finished one, and it no
  // longer counts as open.
  const openIds = done.filter((job) => job.active).map((job) => job.id)
  assert.equal(openIds[openIds.length - 1], "overseed")
  assert.deepEqual(Model.openJobs(done).map((job) => job.id), ["aerate", "fallFeed"])

  // Next year's window starts unchecked, and the old tick is kept.
  assert.equal(find(at("2027-09-01", log), "overseed").doneOn, "")
  log = Model.toggleJob(log, find(at("2026-09-05", log), "overseed"), "2026-09-05")
  assert.deepEqual(log.done, {})

  // Months ahead: a tick still counts for the window that is coming.
  const early = Model.toggleJob(EMPTY_LOG, find(at("2026-06-15", EMPTY_LOG), "overseed"), "2026-06-15")
  assert.equal(find(at("2026-09-01", early), "overseed").doneOn, "2026-06-15")

  // A window that just closed can still be ticked.
  const lateJob = at("2026-11-24", EMPTY_LOG)[0]
  assert.equal(find(at("2026-11-24", Model.toggleJob(EMPTY_LOG, lateJob, "2026-11-24")), "winterizer").doneOn, "2026-11-24")

  // Unknown jobs and junk never make it into the log.
  assert.deepEqual(Model.toggleJob(EMPTY_LOG, { id: MARKUP, since: "2026-01-01", end: "2026-09-30" }, "2026-09-01"), EMPTY_LOG)
  assert.deepEqual(Model.toggleJob(EMPTY_LOG, lateJob, MARKUP), EMPTY_LOG)
  assert.deepEqual(Model.toggleJob(EMPTY_LOG, null, "2026-11-24"), EMPTY_LOG)
})

// ---- Today: mowing weather, growth, and water.

test("today's mowing weather is judged from the forecast alone", () => {
  assert.equal(Model.mowingToday(Model.parseConditions(weather()), "2026-06-15", "Tall fescue"), "today")
  assert.equal(Model.mowingToday(null, "2026-06-15", "Tall fescue"), "")

  const all = (values) => (time) => { const out = {}; for (const f in values) out[f] = time.map(() => values[f]); return out }
  assert.equal(Model.mowingToday(Model.parseConditions(weather(null, all({ precipitation: 1 }))), "2026-06-15", "Tall fescue"), "wet")
  assert.equal(Model.mowingToday(Model.parseConditions(weather(null, all({ temperature_2m: 36 }))), "2026-06-15", "Tall fescue"), "hot")
  const wetToday = (time) => ({ precipitation: time.map((stamp) => (stamp.slice(0, 10) <= "2026-06-15" ? 1 : 0)) })
  assert.equal(Model.mowingToday(Model.parseConditions(weather(null, wetToday)), "2026-06-15", "Tall fescue"), "tomorrow")
  // Rain coming later does not spoil a day that is dry now.
  const rainTonight = (time) => ({ precipitation: time.map((stamp) => (stamp >= "2026-06-15T18:00" ? 3 : 0)) })
  assert.equal(Model.mowingToday(Model.parseConditions(weather(null, rainTonight)), "2026-06-15", "Tall fescue"), "today")

  // Resting goes by the soil over the hours around now, not one reading: a
  // mild afternoon after a cold night is still too cold to grow.
  const frozen = Model.parseConditions(weather({ current: { time: "2026-06-15T10:00", soil_temperature_6cm: 6 } }, all({ soil_temperature_6cm: 3 })))
  assert.equal(frozen.soilC, 6)
  assert.equal(Model.mowingToday(frozen, "2026-06-15", "Tall fescue"), "resting")
  // Bermuda shuts down long before fescue does.
  const cool = Model.parseConditions(weather(null, all({ soil_temperature_6cm: 11 })))
  assert.equal(Model.mowingToday(cool, "2026-06-15", "Bermuda"), "resting")
  assert.equal(Model.mowingToday(cool, "2026-06-15", "Tall fescue"), "today")
})

test("growth is paced by how well the week's temperatures suit the grass", () => {
  const mild = Model.parseConditions(weather())
  assert.equal(Model.growthPace(mild, "2026-06-15", "Tall fescue"), "fast")
  assert.equal(Model.recentGrowth(mild, "2026-06-15", "Tall fescue"), 1)
  // The same mild week holds bermuda back.
  assert.equal(Model.growthPace(mild, "2026-06-15", "Bermuda"), "steady")

  const week = (max, min) => Model.parseConditions(weather(daily((time) => ({ temperature_2m_max: time.map(() => max), temperature_2m_min: time.map(() => min) }))))
  assert.equal(Model.growthPace(week(12, 2), "2026-06-15", "Tall fescue"), "slow")
  assert.equal(Model.growthPace(week(6, 0), "2026-06-15", "Tall fescue"), "none")
  assert.equal(Model.growthPace(null, "2026-06-15", "Tall fescue"), "")

  assert.equal(Model.growthFactor(20, "Tall fescue"), 1)
  assert.equal(Model.growthFactor(2, "Tall fescue"), 0)
  assert.equal(Model.growthFactor(10, "Bermuda"), 0)
})

test("the water balance compares the week's rain with what turf needs", () => {
  // 7 days x 4 mm of evapotranspiration x 0.8, and no rain at all.
  const thirsty = Model.waterBalance(Model.parseConditions(weather()), "2026-06-15", "Tall fescue")
  assert.equal(thirsty.status, "water")
  assert.ok(Math.abs(thirsty.deficitMm - 22.4) < 1e-9)

  const rained = Model.parseConditions(weather(daily((time) => ({ precipitation_sum: time.map((date) => (date <= "2026-06-15" ? 4 : 0)) }))))
  assert.equal(Model.waterBalance(rained, "2026-06-15", "Tall fescue").status, "ok")

  const coming = Model.parseConditions(weather(daily((time) => ({ precipitation_sum: time.map((date) => (date > "2026-06-15" ? 10 : 0)) }))))
  assert.equal(Model.waterBalance(coming, "2026-06-15", "Tall fescue").status, "rain")

  // A cool, dry winter week: the grass is barely growing, so leave the hose alone.
  const winter = Model.parseConditions(weather(
    daily((time) => ({ temperature_2m_max: time.map(() => 9), temperature_2m_min: time.map(() => 1), et0_fao_evapotranspiration: time.map(() => 1.5) })),
    (time) => ({ soil_temperature_6cm: time.map(() => 7) })
  ))
  assert.equal(Model.waterBalance(winter, "2026-06-15", "Tall fescue").status, "resting")

  // No forecast: nothing to say.
  assert.deepEqual(Model.waterBalance(null, "2026-06-15", "Tall fescue"), { needMm: null, rainMm: null, aheadMm: null, deficitMm: null, status: "" })
})

// ---- Alerts and units.

test("an alert fires once per open job's window", () => {
  const jobs = Model.calendar("Tall fescue", "7a", "2026-09-01", null, false, EMPTY_LOG, null)
  const keys = Model.alerts(jobs).map((alert) => alert.key)
  assert.deepEqual(keys, ["job:overseed:2026-08-20", "job:aerate:2026-08-25"])
  // The same window the next day has the same key, so it is not announced twice.
  assert.deepEqual(Model.alerts(Model.calendar("Tall fescue", "7a", "2026-09-02", null, false, EMPTY_LOG, null)).map((alert) => alert.key), keys)
  assert.deepEqual(Model.alerts([]), [])

  assert.deepEqual(Model.parseNotified(Model.serialiseNotified(keys)), keys)
  assert.deepEqual(Model.parseNotified(JSON.stringify(["job:overseed:2026-08-20", MARKUP, 7, "job:" + "x".repeat(200), "other:1"])), ["job:overseed:2026-08-20"])
  assert.deepEqual(Model.parseNotified("{}"), [])
  const many = []
  for (let i = 0; i < 500; i++) many.push("job:overseed:" + Model.dateAfter("2026-01-01", i))
  assert.equal(Model.parseNotified(JSON.stringify(many)).length, Model.MAX_NOTIFIED)
})

test("units follow the locale", () => {
  assert.equal(Model.usesImperial("en_US"), true)
  assert.equal(Model.usesImperial("en_US.UTF-8"), true)
  assert.equal(Model.usesImperial("en_GB"), false)
  assert.equal(Model.usesImperial("da_DK"), false)
  assert.deepEqual(Model.depth(25.4, true), { value: 1, decimals: 2 })
  assert.deepEqual(Model.depth(4.2, false), { value: 4.2, decimals: 1 })
  assert.equal(Model.depth(null, true), null)
  assert.equal(Model.temperature(10, true), 50)
  assert.equal(Model.temperature(null, true), null)
})

// ---- The QML, the catalog, and the manifest, checked as text.

const qmlFiles = fs.readdirSync(root).filter((name) => name.endsWith(".qml"))
const qml = Object.fromEntries(qmlFiles.map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]))
const allQml = Object.values(qml).join("\n")
const modelSource = fs.readFileSync(path.join(root, "Model.js"), "utf8")
const catalog = JSON.parse(fs.readFileSync(path.join(root, "i18n", "en.json"), "utf8"))
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))

test("every label is plain text", () => {
  // PlainText.qml is the only place a Text is declared, and it pins the
  // format, so a markup-shaped place name can never render as rich text.
  for (const [name, source] of Object.entries(qml)) {
    const raw = source.match(/^\s*Text\s*\{/gm) || []
    assert.equal(raw.length, name === "PlainText.qml" ? 1 : 0, name + " declares a raw Text")
    assert.equal(/textFormat:\s*Text\.(AutoText|RichText|StyledText|MarkdownText)/.test(source), false, name)
  }
  assert.match(qml["PlainText.qml"], /textFormat:\s*Text\.PlainText/)
})

test("the only text sent to a shared sink goes through plainText", () => {
  // No tooltips: the bar icon's is blank and nothing else sets one.
  assert.match(qml["Panel.qml"], /tooltipText:\s*""/)
  assert.equal((allQml.match(/tooltipText:/g) || []).length, 1)
  assert.equal(/showTooltip|notify-send/.test(allQml), false)

  // One notification call, in the service, with both strings neutralized.
  const sends = allQml.match(/omarchy-notification-send[^\n]*/g)
  assert.equal(sends.length, 1)
  assert.match(sends[0], /"--app-name", "Lawn Almanac", Model\.plainText\(headline\), Model\.plainText\(body\)\]\)/)
  assert.equal(qml["Service.qml"].includes(sends[0]), true)
})

test("network access is fixed, HTTPS, timed, capped, and all in the service", () => {
  const urls = (allQml + modelSource).match(/https?:\/\/[^\s"']+/g)
  for (const url of urls) assert.match(url, /^https:\/\/((api|geocoding-api|archive-api)\.open-meteo\.com|geo\.omarchy\.org)\//)

  const curls = allQml.match(/\["curl"[^\]]*\]/gs)
  assert.equal(curls.length, 4)
  assert.equal((qml["Service.qml"].match(/\["curl"/g) || []).length, 4)
  for (const call of curls) {
    assert.match(call, /"--proto", "=https"/)
    assert.match(call, /"--max-time"/)
    assert.match(call, /"--max-filesize"/)
  }

  // Nothing is handed to a shell: the one detached command is the
  // notification, passed as an argument list.
  assert.equal(/bash|sh -c|\.run\(|Util\.exec/.test(allQml), false)
  assert.equal((allQml.match(/execDetached/g) || []).length, 1)
})

test("every string the panel asks for is in the English catalog", () => {
  const keys = new Set()
  for (const match of allQml.matchAll(/(?:words|wording|strings)\.tn?\("([^"]+)"/g)) keys.add(match[1])
  for (const state of ["resting", "today", "tomorrow", "wet", "hot"]) keys.add("mow." + state)
  for (const pace of ["fast", "steady", "slow", "none"]) keys.add("pace." + pace)
  for (const status of ["resting", "ok", "rain", "give"]) keys.add("water." + status)
  for (const source of ["weather", "network", "none"]) keys.add("location.source." + source)
  for (const status of ["off", "unavailable", "noLocation", "loading"]) keys.add("conditions." + status)
  for (const key of ["units.in", "units.mm", "units.fahrenheit", "units.celsius", "mow.height.in", "mow.height.cm", "calendar.all", "calendar.less", "unknown"]) keys.add(key)
  for (const grass of Model.GRASSES) keys.add("grass." + grass.id)
  for (const id of Model.jobIds()) keys.add("job." + id)

  for (const key of keys) {
    if (key.endsWith(".")) continue
    assert.ok(key in catalog, "missing string: " + key)
  }
  for (const key of Object.keys(catalog)) assert.ok(keys.has(key), "unused string: " + key)
  for (const plural of ["job.left", "job.in", "job.ago"]) {
    assert.deepEqual(Object.keys(catalog[plural]).sort(), ["one", "other"])
  }
})

test("the manifest matches the code", () => {
  const field = (key) => manifest.barWidget.schema.find((entry) => entry.key === key)
  assert.deepEqual(field("grassType").options, Model.grassNames())
  assert.deepEqual(field("zone").options, [Model.AUTO_ZONE].concat(Model.zoneOptions()))
  assert.equal(field("zone").defaultValue, Model.AUTO_ZONE)
  // Notifications are opt-in.
  assert.equal(field("notify").defaultValue, false)

  assert.deepEqual(manifest.kinds, ["service", "bar-widget"])
  for (const entry of Object.values(manifest.entryPoints)) assert.ok(fs.existsSync(path.join(root, entry)), entry)
  // The plugin's id is written once in the QML, as the widget's default.
  assert.equal((allQml.match(new RegExp(manifest.id.replace(".", "\\."), "g")) || []).length, 1)
  assert.equal(manifest.license, "MIT")
  assert.match(fs.readFileSync(path.join(root, "LICENSE"), "utf8"), /^MIT License/)
})
