const MAX_CHUNK_CHARS = 1900;

function cleanTextForTTS(text) {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/[-\u2013\u2014]{3,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitIntoChunks(text) {
  const headerRegex = /(?=\n{1,2}[A-Z][A-Z\s\/&]{4,}\n{1,2})/g;
  const parts = text.split(headerRegex).filter(p => p.trim().length > 0);
  const chunks = [];
  for (const part of parts) {
    if (part.length <= MAX_CHUNK_CHARS) {
      chunks.push(part.trim());
    } else {
      let remaining = part;
      while (remaining.length > MAX_CHUNK_CHARS) {
        let splitAt = remaining.lastIndexOf('. ', MAX_CHUNK_CHARS);
        if (splitAt === -1) splitAt = remaining.lastIndexOf('? ', MAX_CHUNK_CHARS);
        if (splitAt === -1) splitAt = remaining.lastIndexOf('! ', MAX_CHUNK_CHARS);
        if (splitAt === -1) splitAt = MAX_CHUNK_CHARS;
        chunks.push(remaining.substring(0, splitAt + 1).trim());
        remaining = remaining.substring(splitAt + 1).trim();
      }
      if (remaining.length > 0) chunks.push(remaining.trim());
    }
  }
  return chunks.filter(c => c.length > 0);
}

async function callInworldTTS(text, inworldVoice, apiKey) {
  const response = await fetch('https://api.inworld.ai/tts/v1/voice', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: text,
      voiceId: inworldVoice,
      modelId: 'inworld-tts-1.5-mini',
      audioConfig: {
        audioEncoding: 'MP3'
      }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('Inworld TTS error:', response.status, errText);
    throw new Error('Inworld TTS failed: ' + errText);
  }
  const data = await response.json();
  const audioContent = data.result?.audioContent || data.audioContent;
  if (!audioContent) {
    throw new Error('Inworld TTS returned no audio content');
  }
  return Buffer.from(audioContent, 'base64');
}

async function textToSpeech(text, voice = 'Craig') {
  console.log('TTS request - voice:', voice);
  console.log('TTS text preview (first 100 chars):', JSON.stringify(text.substring(0, 100)));
  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) {
    throw new Error('INWORLD_API_KEY environment variable not set');
  }
  const inworldVoice = (voice === 'nova') ? 'Ashley' : 'Craig';
  const cleanText = cleanTextForTTS(text);
  console.log('TTS clean text length:', cleanText.length, 'chars');
  if (cleanText.length <= MAX_CHUNK_CHARS) {
    console.log('TTS single chunk call');
    const buffer = await callInworldTTS(cleanText, inworldVoice, apiKey);
    console.log('TTS success - audio bytes:', buffer.length, 'voice:', inworldVoice);
    return buffer;
  }
  const chunks = splitIntoChunks(cleanText);
  console.log('TTS splitting into', chunks.length, 'chunks, sizes:', chunks.map(c => c.length));
  const buffers = await Promise.all(
    chunks.map((chunk, i) => {
      console.log('TTS chunk', i + 1, 'of', chunks.length, '- chars:', chunk.length);
      return callInworldTTS(chunk, inworldVoice, apiKey);
    })
  );
  const stitched = Buffer.concat(buffers);
  console.log('TTS stitched audio bytes:', stitched.length, 'from', buffers.length, 'chunks');
  return stitched;
}

module.exports = { textToSpeech };