async function textToSpeech(text, voice = 'onyx') {
  console.log('TTS request - voice:', voice);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }
  const openAIVoice = (voice === 'nova') ? 'nova' : 'onyx';
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: openAIVoice
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('OpenAI TTS error:', response.status, errText);
    throw new Error('OpenAI TTS failed: ' + errText);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('TTS success - audio bytes:', buffer.length, 'voice:', openAIVoice);
  return buffer;
}
module.exports = { textToSpeech };
