const { parser, Strikethrough } = require("@lezer/markdown");

const markupParser = parser.configure(Strikethrough);
const cache = new WeakMap();

function markersFor(doc) {
  if (cache.has(doc)) return cache.get(doc);
  const text = doc.toString();
  const markers = [];
  markupParser.parse(text).iterate({
    enter(node) {
      const delimiter = node.name === "StrongEmphasis" ? "**"
        : node.name === "Strikethrough" ? "~~" : null;
      if (!delimiter) return;
      const first = node.node.firstChild;
      const last = node.node.lastChild;
      if (text.slice(first.from, first.to) !== delimiter ||
          text.slice(last.from, last.to) !== delimiter) return;
      const range = { rangeFrom: node.from, rangeTo: node.to };
      markers.push({ from: first.from, to: first.to, opening: true, ...range });
      markers.push({ from: last.from, to: last.to, opening: false, ...range });
    },
  });
  markers.sort((a, b) => a.from - b.from);
  cache.set(doc, markers);
  return markers;
}

module.exports = { markersFor };
