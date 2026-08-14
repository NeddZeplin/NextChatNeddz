export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GeminiAudio = {
  type?: string;
  data?: string;
  mime_type?: string;
};

function findAudio(response: any): GeminiAudio | null {
  const steps = Array.isArray(response?.steps) ? response.steps : [];

  for (let i = steps.length - 1; i >= 0; i--) {
    const content = Array.isArray(steps[i]?.content) ? steps[i].content : [];

    for (const item of content) {
      if (item?.type === "audio" && item?.data) {
        return item;
      }
    }
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return Response.json(
        { error: "GEMINI_API_KEY is not configured." },
        { status: 500 },
      );
    }

    const body = await request.json();
    const text =
      typeof body?.text === "string" ? body.text.trim() : "";

    if (!text) {
      return Response.json(
        { error: "Please provide some text to speak." },
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
          model: "gemini-3.1-flash-tts-preview",

          input:
            "Read the following text exactly as written. " +
            "Do not add, remove, summarise, rephrase, or answer it. " +
            "Use a natural, relaxed contemporary Australian English speaking style.\n\n" +
            text,

          response_format: {
            type: "audio",
            mime_type: "audio/wav",
            delivery: "inline",
            sample_rate: 24000,
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
      const errorText = await geminiResponse.text();

      console.error(
        "Gemini TTS error:",
        geminiResponse.status,
        errorText,
      );

      return Response.json(
        {
          error: "Gemini could not generate speech.",
          status: geminiResponse.status,
        },
        { status: 502 },
      );
    }

    const result = await geminiResponse.json();
    const audio = findAudio(result);

    if (!audio?.data) {
      console.error("No audio returned by Gemini:", result);

      return Response.json(
        { error: "Gemini returned no audio." },
        { status: 502 },
      );
    }

    const audioBuffer = Buffer.from(audio.data, "base64");

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": audio.mime_type || "audio/wav",
        "Content-Length": String(audioBuffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Voice API error:", error);

    return Response.json(
      { error: "Unable to generate speech." },
      { status: 500 },
    );
  }
}
