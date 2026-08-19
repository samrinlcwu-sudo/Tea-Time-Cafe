const CHAT_API_URL = "/api/chat";
const ERROR_REPLY = "Sorry, I'm having trouble connecting right now. Please try again in a moment.";

const toggleEl = document.getElementById("chat-toggle");
const widgetEl = document.getElementById("chat-widget");
const closeEl = document.getElementById("chat-close");
const messagesEl = document.getElementById("chat-messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const sendButtonEl = document.getElementById("chat-send");

let sessionId = null;
let history = [];

function addBubble(sender, text) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble chat-bubble-${sender}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function openWidget() {
  widgetEl.classList.add("chat-widget-open");
  toggleEl.setAttribute("aria-expanded", "true");
  inputEl.focus();
}

function closeWidget() {
  widgetEl.classList.remove("chat-widget-open");
  toggleEl.setAttribute("aria-expanded", "false");
}

toggleEl.addEventListener("click", () => {
  const isOpen = widgetEl.classList.contains("chat-widget-open");
  if (isOpen) {
    closeWidget();
  } else {
    openWidget();
  }
});

closeEl.addEventListener("click", closeWidget);

async function sendMessage(text) {
  inputEl.disabled = true;
  sendButtonEl.disabled = true;
  const replyBubble = addBubble("bot", "…");

  try {
    const res = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, history, sessionId }),
    });

    const data = await res.json();
    if (!res.ok || typeof data.reply !== "string") {
      throw new Error(data.error || "Request failed");
    }

    replyBubble.textContent = data.reply;
    sessionId = data.sessionId;
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: data.reply });
  } catch {
    replyBubble.textContent = ERROR_REPLY;
  } finally {
    inputEl.disabled = false;
    sendButtonEl.disabled = false;
    inputEl.focus();
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  addBubble("customer", text);
  inputEl.value = "";
  sendMessage(text);
});
