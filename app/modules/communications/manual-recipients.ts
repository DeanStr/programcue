export function namedRecipient(name: string, address: string) {
  if (!name.trim() || /[\r\n]/u.test(name) || /[\r\n<>]/u.test(address)) {
    throw new Error(
      "A named recipient requires a name and a single email address.",
    );
  }
  return `${JSON.stringify(name.trim())} <${address.trim()}>`;
}

export function parseManualRecipients(input: string) {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && /[\n,;]/u.test(character)) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(input.slice(start));
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const named = part.match(/^("(?:[^"\\]|\\.)*"|[^"<>]*?)\s*<([^<>]+)>$/u);
      if (!named) return { name: null, address: part };
      let name = named[1].trim();
      if (name.startsWith('"')) {
        try {
          name = JSON.parse(name) as string;
        } catch {
          return { name: null, address: part };
        }
      }
      return { name: name.trim() || null, address: named[2].trim() };
    });
}
