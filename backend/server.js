// Minimal Tea Time Cafe backend: one endpoint, no dependencies, no framework.
// Run with: node backend/server.js  (Node 20+, uses process.loadEnvFile)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // .env is optional (e.g. vars already set in the environment)
}

const PORT = process.env.PORT || 3000;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;

if (!LLM_API_KEY || !LLM_MODEL) {
  console.warn(
    "Warning: LLM_API_KEY and/or LLM_MODEL is not set. /api/chat will return " +
      "500 until both are configured (see .env.example). The dashboard and " +
      "order endpoints do not require them."
  );
}

const systemPrompt = fs.readFileSync(path.join(ROOT, "prompts", "system_prompt.md"), "utf8");
const menu = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "menu.json"), "utf8"));
const promotions = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "promotions.json"), "utf8"));

const contextBlock =
  `Here is the current menu data as JSON. This is the only valid source of ` +
  `menu items, sizes, and prices — never invent or assume any item, size, ` +
  `or price that is not present here:\n${JSON.stringify(menu)}\n\n` +
  `Here is the current promotions data as JSON:\n${JSON.stringify(promotions)}`;

// In-memory only — order state lives for the life of the process, no database.
const sessions = new Map();

const ORDERS_FILE = path.join(ROOT, "data", "orders.json");

function readSavedOrders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Appends one confirmed order as a new record in data/orders.json. Only ever
// called from confirmOrder after order.confirmed is set — never for a draft.
function saveConfirmedOrder(order) {
  const record = {
    orderId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status: order.status,
    items: order.items,
    orderType: order.orderType,
    customerDetails: order.customerDetails,
    promotion: order.promotion,
    total: order.total,
  };

  const orders = readSavedOrders();
  orders.push(record);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));

  return record;
}

// Statuses staff can move a saved order through from the dashboard.
// "confirmed" is the initial value set by confirmOrder.
const ORDER_STATUSES = ["confirmed", "preparing", "ready", "completed", "cancelled"];

// Updates the status of one saved order in data/orders.json.
function updateOrderStatus(orderId, status) {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    return { ok: false, error: "'orderId' is required." };
  }
  if (typeof status !== "string" || !ORDER_STATUSES.includes(status)) {
    return { ok: false, error: `'status' must be one of: ${ORDER_STATUSES.join(", ")}.` };
  }

  const orders = readSavedOrders();
  const record = orders.find((o) => o.orderId === orderId);
  if (!record) {
    return { ok: false, error: `No saved order matches "${orderId}".` };
  }

  record.status = status;
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));

  return { ok: true, order: record };
}

function createOrder() {
  return {
    items: [], // [{ name, quantity, options }]
    orderType: null, // e.g. "pickup" | "delivery"
    customerDetails: {}, // e.g. { name, phone }
    promotion: null,
    total: 0,
    confirmed: false,
    status: "building", // "building" | "confirmed"
  };
}

function getSession(sessionId) {
  if (typeof sessionId === "string" && sessions.has(sessionId)) {
    return { sessionId, order: sessions.get(sessionId) };
  }
  const id = crypto.randomUUID();
  const order = createOrder();
  sessions.set(id, order);
  return { sessionId: id, order };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Recomputes total from current items, then reapplies the order's promotion
// (if any) so total stays correct after every add/modify/remove/apply.
function recalculateTotal(order) {
  const subtotal = round2(order.items.reduce((sum, item) => sum + item.price * item.quantity, 0));
  if (order.promotion && order.promotion.discount.type === "percentage") {
    order.total = round2(subtotal * (1 - order.promotion.discount.value / 100));
  } else {
    order.total = subtotal;
  }
}

// Plain-text order summary (order type/customer details, items with
// quantities + customizations, promotion, total) for the LLM to relay to
// the customer and to check what's already known before asking again.
function formatOrderSummary(order) {
  const lines = [];

  if (order.confirmed) {
    lines.push("Status: CONFIRMED — this order is already finalized.");
  }

  if (order.orderType) {
    const d = order.customerDetails;
    const details = [];
    if (d.name) details.push(`name: ${d.name}`);
    if (d.phone) details.push(`phone: ${d.phone}`);
    if (d.address) details.push(`address: ${d.address}`);
    if (d.apartmentUnit) details.push(`apartment/unit: ${d.apartmentUnit}`);
    if (d.deliveryInstructions) details.push(`delivery instructions: ${d.deliveryInstructions}`);
    if (d.pickupTime) details.push(`pickup time: ${d.pickupTime}`);
    lines.push(`Order type: ${order.orderType}${details.length ? ` (${details.join(", ")})` : ""}`);
  }

  if (order.items.length === 0) {
    lines.push("The order is currently empty.");
    return lines.join("\n");
  }

  for (const item of order.items) {
    const details = [item.size, ...item.options].filter(Boolean).join(", ");
    const suffix = details ? ` (${details})` : "";
    lines.push(
      `- id ${item.id}: ${item.quantity}x ${item.name}${suffix} — $${round2(
        item.price * item.quantity
      ).toFixed(2)}`
    );
  }

  if (order.promotion) {
    lines.push(
      `Applied promotion: ${order.promotion.name} (${
        order.promotion.discount.type === "percentage"
          ? `${order.promotion.discount.value}% off`
          : order.promotion.discount.value
      })`
    );
  }

  lines.push(`Total: $${order.total.toFixed(2)}`);
  return lines.join("\n");
}

// Adds one line item to the order after validating it against data/menu.json.
// Returns { ok: true, item } or { ok: false, error } — never mutates the order on failure.
function addItemToOrder(order, input) {
  if (order.confirmed) {
    return { ok: false, error: "This order has already been confirmed and can no longer be changed." };
  }

  const itemId = typeof input.itemId === "string" ? input.itemId.trim() : "";
  if (!itemId) {
    return { ok: false, error: "'itemId' is required." };
  }

  const menuItem =
    menu.find((m) => m.id === itemId) ||
    menu.find((m) => m.name.toLowerCase() === itemId.toLowerCase());

  if (!menuItem) {
    return { ok: false, error: `No menu item matches "${itemId}". It is not on the menu.` };
  }
  if (!menuItem.available) {
    return { ok: false, error: `${menuItem.name} is currently unavailable.` };
  }

  let size = null;
  if (menuItem.sizes.length > 0) {
    if (typeof input.size !== "string" || input.size.trim() === "") {
      return {
        ok: false,
        error: `A size is required for ${menuItem.name}.`,
        missing: "size",
        validSizes: menuItem.sizes,
      };
    }
    const match = menuItem.sizes.find((s) => s.toLowerCase() === input.size.trim().toLowerCase());
    if (!match) {
      return {
        ok: false,
        error: `"${input.size}" is not a valid size for ${menuItem.name}.`,
        validSizes: menuItem.sizes,
      };
    }
    size = match;
  }

  let options = [];
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || !input.options.every((o) => typeof o === "string")) {
      return { ok: false, error: "'options' must be an array of strings." };
    }
    for (const opt of input.options) {
      const match = menuItem.options.find((o) => o.toLowerCase() === opt.toLowerCase());
      if (!match) {
        return {
          ok: false,
          error: `"${opt}" is not a valid option for ${menuItem.name}.`,
          validOptions: menuItem.options,
        };
      }
      options.push(match);
    }
  }

  let quantity = 1;
  if (input.quantity !== undefined) {
    quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "'quantity' must be a positive integer." };
    }
  }

  const orderItem = {
    id: crypto.randomUUID(),
    menuItemId: menuItem.id,
    name: menuItem.name,
    quantity,
    size,
    options,
    price: menuItem.price,
  };
  order.items.push(orderItem);
  recalculateTotal(order);

  return { ok: true, item: orderItem };
}

// Changes quantity, size, and/or options on an item already in the order.
// Re-validates any changed field against data/menu.json. Leaves the order
// untouched if any provided field fails validation.
function modifyOrderItem(order, input) {
  if (order.confirmed) {
    return { ok: false, error: "This order has already been confirmed and can no longer be changed." };
  }

  const orderItemId = typeof input.orderItemId === "string" ? input.orderItemId.trim() : "";
  if (!orderItemId) {
    return { ok: false, error: "'orderItemId' is required." };
  }

  const item = order.items.find((i) => i.id === orderItemId);
  if (!item) {
    return { ok: false, error: `No order item matches "${orderItemId}".` };
  }

  if (input.quantity === undefined && input.size === undefined && input.options === undefined) {
    return { ok: false, error: "Provide at least one of 'quantity', 'size', or 'options' to change." };
  }

  const menuItem = menu.find((m) => m.id === item.menuItemId);
  if (!menuItem) {
    return { ok: false, error: `${item.name} is no longer on the menu and cannot be modified.` };
  }

  let quantity = item.quantity;
  if (input.quantity !== undefined) {
    quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "'quantity' must be a positive integer." };
    }
  }

  let size = item.size;
  if (input.size !== undefined) {
    if (menuItem.sizes.length === 0) {
      return { ok: false, error: `${menuItem.name} does not have sizes to change.` };
    }
    if (typeof input.size !== "string" || input.size.trim() === "") {
      return {
        ok: false,
        error: `A valid size is required for ${menuItem.name}.`,
        validSizes: menuItem.sizes,
      };
    }
    const match = menuItem.sizes.find((s) => s.toLowerCase() === input.size.trim().toLowerCase());
    if (!match) {
      return {
        ok: false,
        error: `"${input.size}" is not a valid size for ${menuItem.name}.`,
        validSizes: menuItem.sizes,
      };
    }
    size = match;
  }

  let options = item.options;
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || !input.options.every((o) => typeof o === "string")) {
      return { ok: false, error: "'options' must be an array of strings." };
    }
    const validated = [];
    for (const opt of input.options) {
      const match = menuItem.options.find((o) => o.toLowerCase() === opt.toLowerCase());
      if (!match) {
        return {
          ok: false,
          error: `"${opt}" is not a valid option for ${menuItem.name}.`,
          validOptions: menuItem.options,
        };
      }
      validated.push(match);
    }
    options = validated;
  }

  item.quantity = quantity;
  item.size = size;
  item.options = options;
  recalculateTotal(order);

  return { ok: true, item };
}

// Removes one line item from the order entirely. Returns { ok: true, item }
// (the removed item) or { ok: false, error } if no such item exists.
function removeOrderItem(order, input) {
  if (order.confirmed) {
    return { ok: false, error: "This order has already been confirmed and can no longer be changed." };
  }

  const orderItemId = typeof input.orderItemId === "string" ? input.orderItemId.trim() : "";
  if (!orderItemId) {
    return { ok: false, error: "'orderItemId' is required." };
  }

  const index = order.items.findIndex((i) => i.id === orderItemId);
  if (index === -1) {
    return { ok: false, error: `No order item matches "${orderItemId}".` };
  }

  const [removed] = order.items.splice(index, 1);
  recalculateTotal(order);

  return { ok: true, item: removed };
}

// Applies an active promotion from data/promotions.json to the order. Only
// checks that the promotion exists and is active — conversational eligibility
// (time window, valid ID, minimum size, etc.) is the model's responsibility
// to confirm before calling this. Replaces any promotion already applied,
// since the order only tracks one at a time (promotions aren't combinable).
function applyPromotion(order, input) {
  if (order.confirmed) {
    return { ok: false, error: "This order has already been confirmed and can no longer be changed." };
  }

  const promotionId = typeof input.promotionId === "string" ? input.promotionId.trim() : "";
  if (!promotionId) {
    return { ok: false, error: "'promotionId' is required." };
  }

  const promo =
    promotions.find((p) => p.id === promotionId) ||
    promotions.find((p) => p.name.toLowerCase() === promotionId.toLowerCase());

  if (!promo) {
    return { ok: false, error: `No promotion matches "${promotionId}".` };
  }
  if (!promo.active) {
    return { ok: false, error: `${promo.name} is not currently active.` };
  }

  order.promotion = { id: promo.id, name: promo.name, discount: promo.discount };
  recalculateTotal(order);

  return { ok: true, promotion: order.promotion, total: order.total };
}

// Sets the order as pickup and records the customer's name (required) and an
// optional pickup time. This is the only order type currently supported.
function setPickupDetails(order, input) {
  if (order.confirmed) {
    return { ok: false, error: "This order has already been confirmed and can no longer be changed." };
  }

  const name = typeof input.customerName === "string" ? input.customerName.trim() : "";
  if (!name) {
    return { ok: false, error: "'customerName' is required." };
  }

  let pickupTime;
  if (input.pickupTime !== undefined && input.pickupTime !== null) {
    if (typeof input.pickupTime !== "string" || input.pickupTime.trim() === "") {
      return { ok: false, error: "'pickupTime' must be a non-empty string when provided." };
    }
    pickupTime = input.pickupTime.trim();
  }

  order.orderType = "pickup";
  order.customerDetails = pickupTime ? { name, pickupTime } : { name };

  return { ok: true, orderType: order.orderType, customerDetails: order.customerDetails };
}

// Sets the order as delivery and records the customer's name, phone, and
// address (required), plus apartment/unit and delivery instructions if
// given. Never fills in a missing required field — the caller must provide it.
function setDeliveryDetails(order, input) {
  if (order.confirmed) {
    return { ok: false, error: "This order has already been confirmed and can no longer be changed." };
  }

  const name = typeof input.customerName === "string" ? input.customerName.trim() : "";
  if (!name) {
    return { ok: false, error: "'customerName' is required." };
  }

  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (!phone) {
    return { ok: false, error: "'phone' is required." };
  }

  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!address) {
    return { ok: false, error: "'address' is required." };
  }

  let apartmentUnit;
  if (input.apartmentUnit !== undefined && input.apartmentUnit !== null) {
    if (typeof input.apartmentUnit !== "string" || input.apartmentUnit.trim() === "") {
      return { ok: false, error: "'apartmentUnit' must be a non-empty string when provided." };
    }
    apartmentUnit = input.apartmentUnit.trim();
  }

  let deliveryInstructions;
  if (input.deliveryInstructions !== undefined && input.deliveryInstructions !== null) {
    if (typeof input.deliveryInstructions !== "string" || input.deliveryInstructions.trim() === "") {
      return { ok: false, error: "'deliveryInstructions' must be a non-empty string when provided." };
    }
    deliveryInstructions = input.deliveryInstructions.trim();
  }

  order.orderType = "delivery";
  order.customerDetails = {
    name,
    phone,
    address,
    ...(apartmentUnit ? { apartmentUnit } : {}),
    ...(deliveryInstructions ? { deliveryInstructions } : {}),
  };

  return { ok: true, orderType: order.orderType, customerDetails: order.customerDetails };
}

// Finalizes the order. Only succeeds if there's something to confirm and the
// required order-type details are already on record — the model must only
// call this right after the customer explicitly confirms the final summary,
// never on an ambiguous reply. This is the only place order.confirmed and
// order.status change, so nothing is "finalized" any other way.
function confirmOrder(order) {
  if (order.items.length === 0) {
    return { ok: false, error: "Cannot confirm an empty order." };
  }
  if (order.confirmed) {
    return { ok: false, error: "Order is already confirmed." };
  }
  if (!order.orderType) {
    return { ok: false, error: "Order type (pickup or delivery) must be set before confirming." };
  }
  if (order.orderType === "pickup" && !order.customerDetails.name) {
    return { ok: false, error: "Customer name is required before confirming a pickup order." };
  }
  if (
    order.orderType === "delivery" &&
    (!order.customerDetails.name || !order.customerDetails.phone || !order.customerDetails.address)
  ) {
    return { ok: false, error: "Name, phone, and address are required before confirming a delivery order." };
  }

  order.confirmed = true;
  order.status = "confirmed";

  try {
    const saved = saveConfirmedOrder(order);
    return { ok: true, order, savedOrderId: saved.orderId };
  } catch {
    // Roll back — an order is never left marked confirmed unless it was
    // actually saved.
    order.confirmed = false;
    order.status = "building";
    return { ok: false, error: "Failed to save the confirmed order. Please try confirming again." };
  }
}

const ADD_ITEM_TOOL = {
  name: "add_item_to_order",
  description:
    "Add one valid menu item to the customer's current order. Only call this once the item " +
    "(and its size, if the item has sizes) has been confirmed with the customer — do not call " +
    "it while still asking a clarifying question.",
  input_schema: {
    type: "object",
    properties: {
      itemId: {
        type: "string",
        description: "The 'id' of the menu item from the menu data, exactly as given.",
      },
      size: {
        type: "string",
        description: "The chosen size, required only if the menu item defines sizes.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Any chosen add-ons from the item's 'options' list in the menu data.",
      },
      quantity: {
        type: "integer",
        description: "How many of this item to add. Defaults to 1.",
      },
    },
    required: ["itemId"],
  },
};

const MODIFY_ITEM_TOOL = {
  name: "modify_order_item",
  description:
    "Change the quantity, size, and/or customizations of an item already in the order. " +
    "Use the 'id' of the item from the current order data — not the menu item id. Only " +
    "include the fields that are actually changing.",
  input_schema: {
    type: "object",
    properties: {
      orderItemId: {
        type: "string",
        description: "The 'id' of the item in the current order to change.",
      },
      quantity: {
        type: "integer",
        description: "New quantity, if changing.",
      },
      size: {
        type: "string",
        description: "New size, if changing and the item has sizes.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "The full replacement list of chosen add-ons, if changing.",
      },
    },
    required: ["orderItemId"],
  },
};

const REMOVE_ITEM_TOOL = {
  name: "remove_order_item",
  description:
    "Remove an item from the order entirely. Use the item's 'id' from the current order " +
    "data — not the menu item id. For reducing quantity but keeping the item, use " +
    "modify_order_item instead.",
  input_schema: {
    type: "object",
    properties: {
      orderItemId: {
        type: "string",
        description: "The 'id' of the item in the current order to remove.",
      },
    },
    required: ["orderItemId"],
  },
};

const APPLY_PROMOTION_TOOL = {
  name: "apply_promotion",
  description:
    "Apply an active promotion to the order, using the promotion's 'id' from the promotions " +
    "data. Only call this after confirming with the customer that the order meets the " +
    "promotion's eligibility conditions (e.g. time window, valid student ID, minimum size) — " +
    "this tool only checks that the promotion exists and is active, not those conditions. " +
    "Applying a promotion replaces any promotion already on the order.",
  input_schema: {
    type: "object",
    properties: {
      promotionId: {
        type: "string",
        description: "The 'id' of the promotion from the promotions data, exactly as given.",
      },
    },
    required: ["promotionId"],
  },
};

const SET_PICKUP_DETAILS_TOOL = {
  name: "set_pickup_details",
  description:
    "Set the order as pickup and record the customer's name and, optionally, a requested pickup " +
    "time. Call this once the customer has given their name — pickup time is optional, include " +
    "it only if the customer gave one. Only ask the customer for details not already known from " +
    "the conversation or the current order data.",
  input_schema: {
    type: "object",
    properties: {
      customerName: {
        type: "string",
        description: "The customer's name for the pickup order.",
      },
      pickupTime: {
        type: "string",
        description: "Requested pickup time, if the customer gave one. Omit if not specified.",
      },
    },
    required: ["customerName"],
  },
};

const SET_DELIVERY_DETAILS_TOOL = {
  name: "set_delivery_details",
  description:
    "Set the order as delivery and record the customer's name, phone number, and full delivery " +
    "address (all required), plus apartment/unit number and delivery instructions if the " +
    "customer gives them. Only call this once you actually have each required value from the " +
    "customer — never guess or fill in a placeholder for anything missing.",
  input_schema: {
    type: "object",
    properties: {
      customerName: {
        type: "string",
        description: "The customer's name for the delivery order.",
      },
      phone: {
        type: "string",
        description: "The customer's phone number.",
      },
      address: {
        type: "string",
        description: "The full delivery street address.",
      },
      apartmentUnit: {
        type: "string",
        description: "Apartment or unit number, if applicable. Omit if not applicable.",
      },
      deliveryInstructions: {
        type: "string",
        description: "Delivery instructions, if the customer gave any. Omit if none.",
      },
    },
    required: ["customerName", "phone", "address"],
  },
};

const CONFIRM_ORDER_TOOL = {
  name: "confirm_order",
  description:
    "Finalize the order. Call this ONLY immediately after the customer gives a clear, " +
    "unambiguous confirmation of the exact final order summary you just gave them (e.g. \"yes\", " +
    "\"that's correct\", \"confirmed\", \"place it\"). Never call it on a vague or non-committal " +
    "reply (e.g. \"ok\", \"sure\", \"I guess\"), silence, a question, or a reply that changes the " +
    "order — treat all of those as not a confirmation and ask the customer to clearly confirm or " +
    "say what to change instead.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

function isValidHistory(history) {
  if (!Array.isArray(history)) return false;
  return history.every(
    (turn) =>
      turn &&
      (turn.role === "user" || turn.role === "assistant") &&
      typeof turn.content === "string"
  );
}

async function callAnthropic(messages, order) {
  const orderBlock =
    `Here is a concise summary of the customer's current order. Each line's "id" is only ` +
    `for use with modify_order_item/remove_order_item — never read an id aloud to the ` +
    `customer:\n${formatOrderSummary(order)}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 1024,
      system: `${systemPrompt}\n\n${contextBlock}\n\n${orderBlock}`,
      messages,
      tools: [
        ADD_ITEM_TOOL,
        MODIFY_ITEM_TOOL,
        REMOVE_ITEM_TOOL,
        APPLY_PROMOTION_TOOL,
        SET_PICKUP_DETAILS_TOOL,
        SET_DELIVERY_DETAILS_TOOL,
        CONFIRM_ORDER_TOOL,
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  return response.json();
}

// Runs the conversation with the LLM, executing add_item_to_order tool calls
// against `order` as they come up, until the model produces a final text reply.
async function callLLM(message, history, order) {
  const messages = [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: message },
  ];

  const MAX_TOOL_TURNS = 5;
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const data = await callAnthropic(messages, order);

    if (data.stop_reason !== "tool_use") {
      const reply = data.content?.find((block) => block.type === "text")?.text;
      if (typeof reply !== "string") {
        throw new Error("LLM response did not contain text content");
      }
      return reply;
    }

    messages.push({ role: "assistant", content: data.content });

    const toolResults = data.content
      .filter((block) => block.type === "tool_use")
      .map((block) => {
        const result =
          block.name === "add_item_to_order"
            ? addItemToOrder(order, block.input || {})
            : block.name === "modify_order_item"
            ? modifyOrderItem(order, block.input || {})
            : block.name === "remove_order_item"
            ? removeOrderItem(order, block.input || {})
            : block.name === "apply_promotion"
            ? applyPromotion(order, block.input || {})
            : block.name === "set_pickup_details"
            ? setPickupDetails(order, block.input || {})
            : block.name === "set_delivery_details"
            ? setDeliveryDetails(order, block.input || {})
            : block.name === "confirm_order"
            ? confirmOrder(order)
            : { ok: false, error: `Unknown tool: ${block.name}` };
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      });

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("LLM did not produce a final reply within the tool-use turn limit");
}

function sendJSON(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJSON(res, 404, { error: "Not found" });
      return;
    }
    res.writeHead(200, { "content-type": contentType });
    res.end(data);
  });
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch {
    sendJSON(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { message, history = [], sessionId: requestedSessionId } = body;

  if (typeof message !== "string" || message.trim() === "") {
    sendJSON(res, 400, { error: "'message' must be a non-empty string" });
    return;
  }
  if (!isValidHistory(history)) {
    sendJSON(res, 400, {
      error: "'history' must be an array of { role: 'user'|'assistant', content: string }",
    });
    return;
  }
  if (!LLM_API_KEY || !LLM_MODEL) {
    sendJSON(res, 500, { error: "Server is missing LLM configuration" });
    return;
  }

  const { sessionId, order } = getSession(requestedSessionId);

  try {
    const reply = await callLLM(message.trim(), history, order);
    sendJSON(res, 200, { reply, sessionId, order });
  } catch {
    sendJSON(res, 502, { error: "Failed to get a response from the LLM" });
  }
}

async function handleUpdateOrderStatus(req, res, orderId) {
  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch {
    sendJSON(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const result = updateOrderStatus(orderId, body.status);
  sendJSON(res, result.ok ? 200 : 400, result);
}

const DASHBOARD_HTML_PATH = path.join(ROOT, "frontend", "dashboard.html");
const DASHBOARD_JS_PATH = path.join(ROOT, "frontend", "dashboard.js");
const INDEX_HTML_PATH = path.join(ROOT, "frontend", "index.html");
const STYLE_CSS_PATH = path.join(ROOT, "frontend", "style.css");
const SCRIPT_JS_PATH = path.join(ROOT, "frontend", "script.js");

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  const statusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);

  if (req.method === "POST" && pathname === "/api/chat") {
    handleChat(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/orders") {
    sendJSON(res, 200, { orders: readSavedOrders() });
    return;
  }

  if (req.method === "POST" && statusMatch) {
    handleUpdateOrderStatus(req, res, decodeURIComponent(statusMatch[1]));
    return;
  }

  if (req.method === "GET" && pathname === "/dashboard.html") {
    serveFile(res, DASHBOARD_HTML_PATH, "text/html");
    return;
  }

  if (req.method === "GET" && pathname === "/dashboard.js") {
    serveFile(res, DASHBOARD_JS_PATH, "application/javascript");
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    serveFile(res, INDEX_HTML_PATH, "text/html");
    return;
  }

  if (req.method === "GET" && pathname === "/style.css") {
    serveFile(res, STYLE_CSS_PATH, "text/css");
    return;
  }

  if (req.method === "GET" && pathname === "/script.js") {
    serveFile(res, SCRIPT_JS_PATH, "application/javascript");
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Tea Time Cafe backend listening on port ${PORT}`);
});
