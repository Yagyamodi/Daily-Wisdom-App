import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface ExtractedThought {
  content: string;
  author?: string;
}

export async function parseThoughtsFromText(text: string): Promise<ExtractedThought[]> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Extract individual inspiring thoughts, quotes, or reflections from the following text. 
    For each thought, also identify the author or source. In this text, authors are typically mentioned on the line immediately following the thought, starting with a tilde (e.g., "~ Author Name").
    Return them as a JSON array of objects with 'content' and 'author' fields. Remove the tilde from the author name.
    
    Text:
    ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            content: { type: Type.STRING, description: "The quote or thought itself" },
            author: { type: Type.STRING, description: "The author or source of the thought, if available" }
          },
          required: ["content"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Failed to parse thoughts from Gemini response", e);
    return [];
  }
}

export async function parseThoughtsFromPdf(base64Data: string): Promise<ExtractedThought[]> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        inlineData: {
          mimeType: "application/pdf",
          data: base64Data
        }
      },
      {
        text: "Extract individual inspiring thoughts, quotes, or reflections from this PDF. For each thought, identify the author or source. Authors are typically mentioned on the line following the thought, starting with a tilde (e.g., '~ Author Name'). Return them as a JSON array of objects with 'content' and 'author' fields, removing the tilde from the name."
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            content: { type: Type.STRING, description: "The quote or thought itself" },
            author: { type: Type.STRING, description: "The author or source of the thought, if available" }
          },
          required: ["content"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Failed to parse thoughts from Gemini PDF response", e);
    return [];
  }
}

export async function parseThoughtsFromUrl(url: string): Promise<ExtractedThought[]> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Extract individual inspiring thoughts, quotes, or reflections from the content at this URL: ${url}. 
    For each thought, also identify the author or source. In this text, authors are typically mentioned on the line immediately following the thought, starting with a tilde (e.g., "~ Author Name").
    Return them as a JSON array of objects with 'content' and 'author' fields. Remove the tilde from the author name.`,
    config: {
      tools: [{ urlContext: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            content: { type: Type.STRING, description: "The quote or thought itself" },
            author: { type: Type.STRING, description: "The author or source of the thought, if available" }
          },
          required: ["content"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Failed to parse thoughts from Gemini URL response", e);
    return [];
  }
}
