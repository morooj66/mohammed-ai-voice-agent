export function upsertMessage(messages, message) {
  const index = messages.findIndex(m => m.id === message.id);
  if (index < 0) return [...messages, message];
  return messages.map((m, i) => i === index ? { ...m, ...message } : m);
}
export async function* readEvents(body) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { if (buffer.trim()) throw Error('truncated_stream'); return; }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4_000_000) throw Error('oversized_event');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line) yield JSON.parse(line);
      }
    }
  } finally { reader.releaseLock(); }
}
