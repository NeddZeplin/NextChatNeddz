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

function pcmToWav(
  pcm: Buffer,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(44);

  const byteRate =
    sampleRate * channels * (bitsPerSample / 8);

  const blockAlign =
    channels * (bitsPerSample / 8);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return Response.json(
        {
          error:
            "GEMINI_API_KEY is not configured.",
        },
        { status: 500 },
      );
    }

    const body = await request.json();

    const text =
      typeof body?.text === "string"
        ? body.text.trim()
        : "";

    if (!text) {
      return Response.json(
        {
          error:
            "Please provide some text to speak.",
        },
        { status: 400 },
      );
    }

    if (text.length > 12000) {
      return Response.json(
        { error: "Text is too long." },
        { status: 400 },
      );
    }

    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },

        body: JSON.stringify({
          model:
            "gemini-3.1-flash-tts-preview",

          input:
            "Generate speech from the transcript below. " +
            "Speak only the transcript. " +
            "Do not add, remove, answer, summarise, " +
            "or rewrite anything. " +
            "Use a natural, relaxed contemporary Australian English delivery.\n\n" +
            "TRANSCRIPT:\n" +
            text,

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
          status: geminiResponse.status,
          details: errorText,
        },
        { status: 502 },
      );
    }

    const result =
      await geminiResponse.json();

    const audio = findAudio(result);

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
        { status: 502 },
      );
    }

    const pcm = Buffer.from(
      audio.data,
      "base64",
    );

    const wav = pcmToWav(pcm);

    return new Response(wav, {
      status: 200,

      headers: {
        "Content-Type": "audio/wav",
        "Content-Length":
          String(wav.length),
        "Cache-Control": "no-store",
      },
    });
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
      { status: 500 },
    );
  }
}
