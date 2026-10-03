// Netlify Function: keeps your Groq key secret on the server.
const ALLOWED = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  let b;
  try { b = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: "Bad JSON" }; }

  if (!Array.isArray(b.messages) || b.messages.length > 40 ||
      JSON.stringify(b.messages).length > 40000) {
    return { statusCode: 400, body: "Bad request" };
  }
  if (!ALLOWED.includes(b.model)) b.model = ALLOWED[0];
  b.max_tokens = Math.min(b.max_tokens || 320, 500);

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.GROQ_API_KEY,
    },
    body: JSON.stringify(b),
  });
  return {
    statusCode: r.status,
    headers: { "Content-Type": "application/json" },
    body: await r.text(),
  };
};
