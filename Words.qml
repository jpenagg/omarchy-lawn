import QtQuick
import qs.Commons
import qs.Commons as Commons
import "Model.js" as Model

// The panel's wording: the plugin's own strings, and the numbers, dates, and
// units written the way the chosen language writes them. Every function here
// reads the catalog, so a binding that calls one re-renders when the language
// changes.
QtObject {
  id: words

  // The lawn service, for its units.
  property var store: null
  readonly property bool imperial: store ? store.imperial : true

  property QtObject strings: Commons.Translations { directory: Qt.resolvedUrl("i18n") }

  function t(key, fallback) { return strings.t(key, fallback) }
  function tn(key, count) { return strings.tn(key, count).arg(whole(count)) }

  function whole(value) { return Commons.I18n.formatNumber(value, 0) }
  function number(value) { return Commons.I18n.formatNumber(value, value % 1 === 0 ? 0 : 1) }

  function locale() { return Qt.locale(Commons.I18n.formatLocale) }

  function shortDate(iso) {
    var date = new Date(parseInt(iso.slice(0, 4), 10), parseInt(iso.slice(5, 7), 10) - 1, parseInt(iso.slice(8, 10), 10))
    return locale().toString(date, "MMM d")
  }

  function dateRange(from, to) { return t("range").arg(shortDate(from)).arg(shortDate(to)) }

  // An hour of the day (0 to 24), short: "2 PM" where the language keeps
  // time by the twelve-hour clock, "14:00" where it does not.
  function hour(value) {
    var l = locale()
    var twelve = /a/i.test(l.timeFormat(Locale.ShortFormat).replace(/'[^']*'/g, ""))
    return l.toString(new Date(2000, 0, 1, value % 24, 0, 0), twelve ? "h AP" : "HH:mm")
  }

  function depth(mm) {
    var d = Model.depth(mm, imperial)
    if (!d) return t("unknown")
    return t(imperial ? "units.in" : "units.mm").arg(Commons.I18n.formatNumber(d.value, d.decimals))
  }

  function temperature(celsius) {
    var value = Model.temperature(celsius, imperial)
    if (value === null) return t("unknown")
    return t(imperial ? "units.fahrenheit" : "units.celsius").arg(whole(value))
  }

  function grass(entry) { return t("grass." + entry.id, entry.name) }
}
