function parseLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

export function parseCsv(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const columns = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = parseLine(line);
    return Object.fromEntries(columns.map((name, i) => [name, fields[i] ?? ""]));
  });
}
