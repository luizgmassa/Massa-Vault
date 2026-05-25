export const analyzeConstructionPhoto = async (

imageBuffer: Buffer,

imageMimeType: string,

afterImageBuffer?: Buffer,

afterImageMimeType?: string

): Promise<string> => {

if (!GEMINI_API_KEY) {

throw new ApiError("critical", "GEMINI_API_KEY não está configurada no servidor");

}

  

try {

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  

const parts: Part[] = [

{ text: SYSTEM_CONTEXT },

{

inlineData: {

mimeType: imageMimeType,

data: bufferToBase64(imageBuffer)

}

}

];

  

if (afterImageBuffer && afterImageMimeType) {

parts.push({

inlineData: {

mimeType: afterImageMimeType,

data: bufferToBase64(afterImageBuffer)

}

});

}

  

const response = await ai.models.generateContent({

model: "gemini-2.5-flash",

contents: [{ role: "user", parts }],

config: {

temperature: 0.4,

maxOutputTokens: 256,

topP: 0.8,

topK: 10

}

});

  

const text = response.text;

  

if (!text) {

throw new ApiError("critical", "A IA não gerou nenhuma descrição");

}

  

return text.trim().replace(/^["']|["']$/g, "");

} catch (error: any) {

logger.error({ err: error }, "ai.analyzeConstructionPhoto error:");

throw new ApiError(error.type ?? "critical", error.message ?? "Erro ao analisar foto com IA");

}

};