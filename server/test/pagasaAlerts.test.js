const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAlert, parseAtom, parseCap, parseSignal, pointInPolygon, productSummary } = require("../src/weather/pagasaAlertService");

test("PAGASA Atom feed exposes CAP links", () => {
  const feed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:test</id><title>TCWS Alert</title><updated>2099-01-01T00:00:00+08:00</updated><link type="application/cap+xml" href="https://example.test/alert.cap"/></entry></feed>`;
  assert.deepEqual(parseAtom(feed), [{ id: "urn:test", title: "TCWS Alert", updated: "2099-01-01T00:00:00+08:00", href: "https://example.test/alert.cap" }]);
});

test("PAGASA CAP parser extracts official TCWS and matches farm polygon", () => {
  const cap = `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>tc-1</identifier><sender>PAGASA-DOST</sender><sent>2099-01-01T00:00:00+08:00</sent><status>Actual</status><msgType>Alert</msgType><info><event>Tropical Cyclone Wind Signal No. 2</event><urgency>Expected</urgency><severity>Severe</severity><certainty>Likely</certainty><expires>2099-01-02T00:00:00+08:00</expires><headline>TCWS No. 2 is in effect</headline><description>Typhoon TEST warning</description><instruction>Secure farm equipment.</instruction><area><areaDesc>Test Province</areaDesc><polygon>14,120 15,120 15,121 14,121 14,120</polygon><geocode><valueName>SAME</valueName><value>010000000</value></geocode></area></info></alert>`;
  const alert = parseCap(cap, { latitude: 14.5, longitude: 120.5, name: "Farm" });
  assert.equal(alert.signal_number, 2);
  assert.equal(alert.active, true);
  assert.equal(alert.farm_affected, true);
  assert.deepEqual(alert.matched_areas, ["Test Province"]);
});

test("PAGASA categorizes farm hazards and extracts page guidance", () => {
  assert.equal(classifyAlert("General Flood Advisory"), "rainfall_flood");
  assert.equal(classifyAlert("Thunderstorm Advisory"), "thunderstorm");
  assert.equal(classifyAlert("Gale Warning"), "coastal");
  assert.match(productSummary("<nav>Menu<\/nav><h1>Farm Weather Forecast<\/h1><p>Leaf Wetness 4-8 hours<\/p>", "Farm Weather Forecast"), /Leaf Wetness/);
});

test("PAGASA parser does not infer a signal from unrelated numbers", () => {
  assert.equal(parseSignal("Typhoon bulletin number 5"), null);
  assert.equal(pointInPolygon(20, 120.5, "14,120 15,120 15,121 14,121"), false);
});
