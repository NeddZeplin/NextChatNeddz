export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AudioBlock = {
  type?: string;
  data?: string;
  mime_type?: string;
};

function findAudio(response: any): AudioBlock | null {
  if (response?.output_audio?.data) {
    return response.output_audio;
  }

  const steps = Array.isArray(response?.steps)
    ? response.steps
    : [];

  for (let i = steps.length - 1; i >= 0; i--) {
    const content = Array.isArray(steps[i]?.content)
      ? steps[i].content
      : [];

    for (const item of content) {
      if (item?.type === "audio" && item?.data) {
        return item;
      }
    }
  }

  return null;
}

/*
 * Gemini TTS gives us 24 kHz, 16-bit, mono PCM.
 *
 * This doubles it to 48 kHz using simple linear interpolation.
 * The duration stays the same; we just create an intermediate
 * sample between each original sample.
 */
function upsample24kTo48k(pcm: Buffer): Buffer {
  const inputSamples = Math.floor(pcm.length / 2);

  if (inputSamples < 2) {
    return pcm;
  }

  const output = Buffer.alloc(inputSamples * 4);

  for (let i = 0; i < inputSamples; i++) {
    const current = pcm.readInt16LE(i * 2);

    const next =
      i + 1 < inputSamples
        ? pcm.readInt16LE((i + 1) * 2)
        : current;

    const middle = Math.round(
      (current + next) / 2,
    );

    const outputOffset = i * 4;

    output.writeInt16LE(
      current,
      outputOffset,
    );

    output.writeInt16LE(
      middle,
      outputOffset + 2,
    );
  }

  return output;
}

function pcmToWav(
  pcm: Buffer,
  sampleRate = 48000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(44);

  const bytesPerSample =
    bitsPerSample / 8;

  const byteRate =
    sampleRate *
    channels *
    bytesPerSample;

  const blockAlign =
    channels *
    bytesPerSample;

  header.write("RIFF", 0);
  header.writeUInt32LE(
    36 + pcm.length,
    4,
  );

  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(
    channels,
    22,
  );

  header.writeUInt32LE(
    sampleRate,
    24,
  );

  header.writeUInt32LE(
    byteRate,
    28,
  );

  header.writeUInt16LE(
    blockAlign,
    32,
  );

  header.writeUInt16LE(
    bitsPerSample,
    34,
  );

  header.write("data", 36);

  header.writeUInt32LE(
    pcm.length,
    40,
  );

  return Buffer.concat([
    header,
    pcm,
  ]);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS",

  "Access-Control-Allow-Headers":
    "Content-Type",

  "Accept-Ranges": "bytes",
};

async function generateSpeech(
  text: string,
) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        error:
          "GEMINI_API_KEY is not configured.",
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }

  const cleanText = text.trim();

  if (!cleanText) {
    return Response.json(
      {
        error:
          "Please provide some text to speak.",
      },
      {
        status: 400,
        headers: corsHeaders,
      },
    );
  }

  if (cleanText.length > 12000) {
    return Response.json(
      {
        error:
          "Text is too long.",
      },
      {
        status: 400,
        headers: corsHeaders,
      },
    );
  }

  try {
    const geminiResponse =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              apiKey,
          },

          body: JSON.stringify({
            model:
              "gemini-2.5-flash-preview-tts",

            input:
              "Generate speech from the transcript below. " +
              "Speak only the transcript. " +
              "Do not add, remove, answer, summarise, " +
              "or rewrite anything. " +
              "Use a natural, relaxed contemporary Australian English delivery.\n\n" +
              "TRANSCRIPT:\n" +
              cleanText,

            response_format: {
              type: "audio",
            },

            generation_config: {
              speech_config: [
                {
                  voice: "Kore",
                },
              ],
            },
          }),
        },
      );

    if (!geminiResponse.ok) {
      const errorText =
        await geminiResponse.text();

      console.error(
        "Gemini TTS error:",
        geminiResponse.status,
        errorText,
      );

      return Response.json(
        {
          error:
            "Gemini could not generate speech.",

          status:
            geminiResponse.status,

          details:
            errorText,
        },
        {
          status: 502,
          headers: corsHeaders,
        },
      );
    }

    const result =
      await geminiResponse.json();

    const audio =
      findAudio(result);

    if (!audio?.data) {
      console.error(
        "Gemini returned no audio:",
        JSON.stringify(result),
      );

      return Response.json(
        {
          error:
            "Gemini returned no audio.",
        },
        {
          status: 502,
          headers: corsHeaders,
        },
      );
    }

    /*
     * Gemini supplies:
     * 24 kHz / mono / 16-bit PCM
     */
    const pcm24k =
      Buffer.from(
        audio.data,
        "base64",
      );

    /*
     * Convert to:
     * 48 kHz / mono / 16-bit PCM
     */
    const pcm48k =
      upsample24kTo48k(
        pcm24k,
      );

    const wav =
      pcmToWav(
        pcm48k,
        48000,
        1,
        16,
      );

    return new Response(
      wav,
      {
        status: 200,

        headers: {
          ...corsHeaders,

          "Content-Type":
            "audio/wav",

          "Content-Length":
            String(
              wav.length,
            ),

          "Cache-Control":
            "public, max-age=300",

          "Content-Disposition":
            'inline; filename="voice.wav"',
        },
      },
    );
  } catch (error) {
    console.error(
      "Voice API error:",
      error,
    );

    return Response.json(
      {
        error:
          "Unable to generate speech.",
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
}

export async function GET(
  request: Request,
) {
  const url =
    new URL(request.url);

  const text =
    url.searchParams.get("text") ||
    "";

  return generateSpeech(text);
}

export async function POST(
  request: Request,
) {
  try {
    const body =
      await request.json();

    const text =
      typeof body?.text ===
      "string"
        ? body.text
        : "";

    return generateSpeech(text);
  } catch {
    return Response.json(
      {
        error:
          "Invalid JSON request.",
      },
      {
        status: 400,
        headers: corsHeaders,
      },
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}
