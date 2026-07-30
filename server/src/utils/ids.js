function eventId(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `event_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`;
}
module.exports = { eventId };
