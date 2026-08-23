// Tea Time Cafe backend: Express server serving the frontend and the chat API.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 3000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD;
const CHAT_MODEL = "claude-haiku-4-5-20251001";
const FALLBACK_REPLY = "Sorry, I'm having trouble reaching the kitchen right now — please try again in a moment.";

// Simple flat-rate config — adjust here if rates change. No per-item tax rules.
const TAX_RATE = 0.08;
const DELIVERY_FEE = 3.0;

// Orders are persisted by reading/writing this JSON file directly. This is
// fine for local development and demos, but not for production: on
// serverless platforms like Vercel, functions run in ephemeral instances
// with a read-only (or non-shared) filesystem, so writes here are not
// guaranteed to persist or to be visible across requests. Replace with a
// real database before deploying anywhere serverless.
const ORDERS_PATH = path.join(ROOT, "data", "orders.json");
const ORDER_STATUSES = ["NEW", "PREPARING", "READY", "COMPLETED"];

const BASE_SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, "prompts", "system-prompt.md"), "utf8");
const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n## Menu Lookups\n\nUse the \`getMenu\` tool to look up current, active menu items whenever the customer asks about the menu — never answer from memory or invent items, prices, sizes, or allergens.\n\n## Adding Items\n\nUse the \`addItemToCart\` tool to add an item once you know its id (from getMenu), quantity, and size (if the item has sizes). If a required size is missing, the tool will refuse and tell you what's needed — ask the customer for it instead of guessing. Only call the tool once you have everything it needs.\n\n## Modifying Items\n\nUse the \`modifyItem\` tool to change the quantity, size, or options of an item already in the order — identify it by its position (itemIndex) in the order's items array, as most recently shown to you. If the change is invalid (bad size/option, or quantity below 1), the tool will refuse and explain why — ask the customer rather than retrying with a guess. This tool cannot remove items or take them to zero.\n\n## Removing Items\n\nUse the \`removeItem\` tool to remove an item entirely, or reduce its quantity, from the order — identify it by its position (itemIndex) in the order's items array, as most recently shown to you. Omit \`quantity\` to remove the item entirely; pass a \`quantity\` to remove just that many (the item is removed entirely if that meets or exceeds what's there). If the index doesn't exist, the tool will refuse and explain why — ask the customer rather than retrying with a guess.\n\n## Viewing the Cart\n\nUse the \`viewCart\` tool to see the current order's items, quantities, and customizations — e.g. before confirming, before modifying/removing by index, or whenever the customer asks what's in their order. It does not include a total yet.\n\n## Recommendations\n\nAfter adding an item to the order, you may call \`getRecommendations\` to see 1-2 real, currently-available menu items that pair well with the order. Only mention items the tool actually returns — never invent a suggestion. If the tool returns an empty list, don't offer anything. Offer a suggestion at most once per item — the tool already tracks what's been suggested and won't return the same item twice, so if the customer declines or ignores a suggestion, don't bring it up again.\n\n## Promotions\n\nUse \`applyPromotion\` with no \`promotionId\` to check which active promotions (from data/promotions.json) the current order currently qualifies for, and only mention promotions it actually returns — never invent a discount, percentage, or code. To apply one, call it again with that exact \`promotionId\`. If it applies the Student Discount, tell the customer they'll need to show a valid student ID at pickup/register. Never accept or apply a discount code the customer types in themselves unless it matches a promotion the tool confirms is real, active, and eligible — if it doesn't, tell them it's not valid rather than guessing what they meant.\n\n## Pickup Details\n\nBefore finalizing an order, call \`setPickupDetails\` with no arguments to see what's already been collected. It returns the current name, pickup time, and a \`missing\` list — only ask the customer for what's actually listed as missing. Name is required; pickup time is optional, so if the customer doesn't give one, proceed without it. Once you have new information to record, call the tool again passing just the field(s) you're setting.\n\n## Delivery Details\n\nIf the customer wants delivery instead of pickup, call \`setDeliveryDetails\` with no arguments to see what's already been collected. It returns the current name, phone, address, apartment/unit, delivery instructions, and a \`missing\` list — only ask for what's actually listed as missing. Name, phone, and address are required; apartment/unit and delivery instructions are optional, so don't ask for them unless it's natural to (e.g. after getting the address). Never guess or fill in any of these fields yourself — only record what the customer actually told you. Once you have new information, call the tool again passing just the field(s) you're setting.\n\nBefore checkout on a delivery order, once \`missing\` is empty, read the full captured address back to the customer (street address, apartment/unit if any, and delivery instructions if any) and explicitly ask them to confirm it's correct — do not proceed to checkout without this. If they confirm, call \`setDeliveryDetails\` again with only \`confirmed: true\`. If they correct anything, set the corrected field(s) instead (this automatically clears the prior confirmation), then read the updated address back and ask again.\n\n## Order Total\n\nNever calculate, estimate, or state a subtotal, tax, delivery fee, or total yourself — always call \`getOrderTotal\` and report exactly the numbers it returns. Call it whenever the customer asks what they owe, and always right before final checkout confirmation. Delivery fee only applies to delivery orders; it will be 0 for pickup. If a promotion is applied, its discount amount is already reflected in the numbers returned.\n\n## Order Summary\n\nBefore asking the customer for final checkout confirmation, call \`getOrderSummary\` and present exactly what it returns: the items with quantities/customizations, the fulfillment details (pickup or delivery), the applied promotion (if any), and the full price breakdown. Don't reconstruct this from memory or earlier tool calls — always pull the current state fresh from this tool right before checkout, since anything could have changed since you last checked.\n\n## Confirming and Saving the Order\n\nOnly call \`confirmOrder\` (with confirmed: true) after the customer has explicitly confirmed the summary you presented — a clear \"yes\", \"confirm\", \"place the order\", or equivalent. Never call it proactively, right after showing the summary without a reply, or on an assumption that they're done. Never save a draft, incomplete, or unconfirmed order this way. If it returns an error, tell the customer what's missing or wrong rather than retrying blindly. Never tell the customer their order is placed, and never state an order ID, unless \`confirmOrder\` just returned \`saved: true\` in this same turn — quote the \`orderId\` field exactly as returned, character for character; never invent, guess, shorten, or reformat it.`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOLS = [
  {
    name: "getMenu",
    description: "Returns the café's current menu, limited to active (available) items only. Each item includes id, name, category, description, price, sizes, options, allergens, and dietary tags.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "addItemToCart",
    description: "Adds a valid, available menu item to the customer's order. Fails with an error describing what's missing if the item id is invalid/unavailable, a required size is missing or not offered by the item, or an option isn't offered by the item — ask the customer rather than retrying with a guess.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The menu item's id, from getMenu." },
        quantity: { type: "integer", minimum: 1, description: "How many to add. Defaults to 1." },
        size: { type: "string", description: "Required if the item has sizes (see getMenu) — must exactly match one of them." },
        options: { type: "array", items: { type: "string" }, description: "Optional add-ons; each must match one of the item's options." },
      },
      required: ["itemId"],
    },
  },
  {
    name: "modifyItem",
    description: "Adjusts the quantity, size, and/or options of an item already in the order. Fails with an error if the item index doesn't exist, the size/options aren't valid for that item, or quantity would drop below 1 — ask the customer rather than retrying with a guess. Does not support removing an item.",
    input_schema: {
      type: "object",
      properties: {
        itemIndex: { type: "integer", minimum: 0, description: "0-based position of the item in the order's current items array." },
        quantity: { type: "integer", minimum: 1, description: "New quantity. Omit to leave unchanged." },
        size: { type: "string", description: "New size. Omit to leave unchanged. Must be one of the item's valid sizes." },
        options: { type: "array", items: { type: "string" }, description: "New full list of options, replacing the existing one. Omit to leave unchanged. Each must be valid for the item." },
      },
      required: ["itemIndex"],
    },
  },
  {
    name: "removeItem",
    description: "Removes an item from the order entirely, or reduces its quantity. Fails with an error if the item index doesn't exist — ask the customer rather than retrying with a guess.",
    input_schema: {
      type: "object",
      properties: {
        itemIndex: { type: "integer", minimum: 0, description: "0-based position of the item in the order's current items array." },
        quantity: { type: "integer", minimum: 1, description: "How many to remove. Omit to remove the item entirely regardless of its current quantity." },
      },
      required: ["itemIndex"],
    },
  },
  {
    name: "viewCart",
    description: "Returns a concise, itemized summary of the current order: each item's name, quantity, size, and options. Does not include prices or a total.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "getRecommendations",
    description: "Returns up to 2 real, available menu items that pair well with the current order, for you to suggest to the customer. Excludes items already in the order and items already suggested this session (so a declined or ignored suggestion is never repeated). May return an empty list if there's nothing left to suggest — in that case, don't offer anything.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "applyPromotion",
    description: "Without promotionId: returns the active promotions from data/promotions.json that the current order is eligible for right now, for you to recommend. With promotionId: attempts to apply that exact promotion. Fails with an error if the id isn't a real, currently-active promotion (never apply or invent a discount code that isn't in this list), if a promotion is already applied, or if the order doesn't meet that promotion's eligibility rules — in which case the error explains why.",
    input_schema: {
      type: "object",
      properties: {
        promotionId: { type: "string", description: "The promotion's id, from a prior call to this tool. Omit to just check what's eligible." },
      },
    },
  },
  {
    name: "setPickupDetails",
    description: "Records the customer's name and (optional) pickup time for order pickup. Call with no arguments to check what's already been collected and what's still missing, before asking the customer anything. Call again with only the field(s) you're setting — existing values are preserved. Fails if name is set to an empty value.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The customer's name for the pickup order." },
        pickupTime: { type: "string", description: "Requested pickup time, as the customer said it (e.g. \"3:30pm\", \"in 20 minutes\"). Optional." },
      },
    },
  },
  {
    name: "setDeliveryDetails",
    description: "Records the customer's name, phone number, delivery address, and (optional) apartment/unit and delivery instructions. Call with no arguments to check what's already been collected and what's still missing, before asking the customer anything. Call again with only the field(s) you're setting — existing values are preserved. Never guess or fill in a value the customer hasn't given you. Fails if a required field is set to an empty value. Setting any field clears prior address confirmation, so it must be re-confirmed. Pass confirmed: true (with no other fields, and only after reading the full address back to the customer and getting an explicit yes) to mark the address confirmed for checkout; fails if required fields are still missing.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The customer's name for the delivery order." },
        phone: { type: "string", description: "Contact phone number, as the customer gave it." },
        address: { type: "string", description: "Full delivery street address." },
        apartment: { type: "string", description: "Apartment/unit/suite number, if applicable. Optional." },
        instructions: { type: "string", description: "Delivery instructions (e.g. gate code, where to leave it). Optional." },
        confirmed: { type: "boolean", description: "Set true, by itself, once the customer has explicitly confirmed the full address you read back to them." },
      },
    },
  },
  {
    name: "getOrderTotal",
    description: "Returns the deterministic, server-calculated order total: subtotal (real menu prices × quantities), any applied promotion's discount amount, tax, delivery fee (delivery orders only), and the final grand total. This is the only source of truth for prices — never calculate, estimate, or state a subtotal/tax/fee/total yourself. Fails if the order is empty.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "getOrderSummary",
    description: "Returns the complete, structured order summary for a final pre-checkout review: items with quantities and customizations, fulfillment details (pickup or delivery, whichever was set), the applied promotion (if any), and the full price breakdown. Call this right before asking the customer to confirm and finalize — present exactly what it returns, don't reconstruct it from memory. Fails if the order is empty.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "confirmOrder",
    description: "Saves the order to data/orders.json with a unique order ID, timestamp, and status \"NEW\". Only call this with confirmed: true, and only after the customer has explicitly confirmed the order summary from getOrderSummary (e.g. said \"yes\", \"confirm it\", \"place the order\") — never call it proactively or on an assumption. Fails if confirmed isn't true, if the order is empty, if fulfillment details are incomplete, if a delivery address hasn't been explicitly confirmed, or if this order was already saved.",
    input_schema: {
      type: "object",
      properties: {
        confirmed: { type: "boolean", description: "Must be true. Only pass true once the customer has explicitly said they want to place the order." },
      },
      required: ["confirmed"],
    },
  },
];

function getMenu() {
  const menu = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "menu.json"), "utf8"));
  return menu.filter((item) => item.available);
}

// Recomputes order.total from scratch, applying order.discount (if any) so a
// discount survives later cart edits instead of being silently dropped.
function computeOrderTotal(order, menu) {
  const base = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (!order.discount) {
    return Math.round(base * 100) / 100;
  }
  // Percentage always comes from the applied promotion's own data, not a
  // hardcoded copy, so totals stay correct if promotions.json changes.
  const rate = 1 - (order.discount.discount?.value || 0) / 100;
  if (order.discount.id === "happy-hour") {
    const discounted = order.items.reduce((sum, item) => {
      const category = menu.find((m) => m.id === item.id)?.category;
      return sum + item.price * item.quantity * (category === "coffee" ? rate : 1);
    }, 0);
    return Math.round(discounted * 100) / 100;
  }
  if (order.discount.id === "student-discount") {
    return Math.round(base * rate * 100) / 100;
  }
  return Math.round(base * 100) / 100;
}

function addItemToCart(input, order) {
  const { itemId, quantity, size, options } = input || {};
  const menu = getMenu();
  const menuItem = menu.find((item) => item.id === itemId);

  if (!menuItem) {
    return { error: `No available menu item with id "${itemId}". Use getMenu to look up valid ids.` };
  }

  if (menuItem.sizes.length > 0 && !menuItem.sizes.includes(size)) {
    return {
      error: "size_required",
      message: `"${menuItem.name}" requires a size. Ask the customer to choose one.`,
      validSizes: menuItem.sizes,
    };
  }

  const requestedOptions = Array.isArray(options) ? options : [];
  const invalidOptions = requestedOptions.filter((opt) => !menuItem.options.includes(opt));
  if (invalidOptions.length > 0) {
    return {
      error: "invalid_options",
      message: `These options aren't available for "${menuItem.name}": ${invalidOptions.join(", ")}.`,
      validOptions: menuItem.options,
    };
  }

  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const itemSize = menuItem.sizes.length > 0 ? size : null;
  const optionsKey = [...requestedOptions].sort().join("|");

  // Merge into an identical existing line instead of creating a duplicate,
  // so a repeated add (customer or model) increments quantity, not a new row.
  const existing = order.items.find(
    (item) => item.id === menuItem.id && item.size === itemSize && [...item.options].sort().join("|") === optionsKey
  );

  let cartItem;
  if (existing) {
    existing.quantity += qty;
    cartItem = existing;
  } else {
    cartItem = {
      id: menuItem.id,
      name: menuItem.name,
      quantity: qty,
      size: itemSize,
      options: requestedOptions,
      price: menuItem.price,
    };
    order.items.push(cartItem);
  }

  order.total = computeOrderTotal(order, menu);

  return { added: cartItem, cart: { items: order.items, total: order.total } };
}

function modifyItem(input, order) {
  const { itemIndex, quantity, size, options } = input || {};

  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= order.items.length) {
    return { error: `No item at index ${itemIndex}. The order currently has ${order.items.length} item(s).` };
  }

  const cartItem = order.items[itemIndex];
  const menu = getMenu();
  const menuItem = menu.find((item) => item.id === cartItem.id);

  if (!menuItem) {
    return { error: `"${cartItem.name}" is no longer available and can't be modified.` };
  }

  if (size !== undefined) {
    if (menuItem.sizes.length === 0 || !menuItem.sizes.includes(size)) {
      return {
        error: "invalid_size",
        message: `"${menuItem.name}" doesn't offer size "${size}".`,
        validSizes: menuItem.sizes,
      };
    }
  }

  if (options !== undefined) {
    const requestedOptions = Array.isArray(options) ? options : [];
    const invalidOptions = requestedOptions.filter((opt) => !menuItem.options.includes(opt));
    if (invalidOptions.length > 0) {
      return {
        error: "invalid_options",
        message: `These options aren't available for "${menuItem.name}": ${invalidOptions.join(", ")}.`,
        validOptions: menuItem.options,
      };
    }
  }

  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
    return { error: "Quantity must be at least 1. Removing items isn't supported yet." };
  }

  if (size !== undefined) cartItem.size = size;
  if (options !== undefined) cartItem.options = Array.isArray(options) ? options : [];
  if (quantity !== undefined) cartItem.quantity = quantity;

  order.total = computeOrderTotal(order, menu);

  return { updated: cartItem, cart: { items: order.items, total: order.total } };
}

function removeItem(input, order) {
  const { itemIndex, quantity } = input || {};

  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= order.items.length) {
    return { error: `No item at index ${itemIndex}. The order currently has ${order.items.length} item(s).` };
  }

  const cartItem = order.items[itemIndex];
  const name = cartItem.name;
  let fullyRemoved = true;

  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: "Quantity to remove must be at least 1." };
    }
    if (quantity < cartItem.quantity) {
      cartItem.quantity -= quantity;
      fullyRemoved = false;
    } else {
      order.items.splice(itemIndex, 1);
    }
  } else {
    order.items.splice(itemIndex, 1);
  }

  order.total = computeOrderTotal(order, getMenu());

  return { name, fullyRemoved, cart: { items: order.items, total: order.total } };
}

function viewCart(order) {
  return {
    items: order.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      size: item.size,
      options: item.options,
    })),
  };
}

const DRINK_CATEGORIES = ["coffee", "tea", "cold drinks"];
const FOOD_CATEGORIES = ["pastries", "food", "snacks"];

function getRecommendations(order) {
  const menu = getMenu();
  const cartIds = new Set(order.items.map((item) => item.id));
  const suggestedIds = new Set(order.suggestedItemIds);

  const candidates = menu.filter((item) => !cartIds.has(item.id) && !suggestedIds.has(item.id));
  if (candidates.length === 0) {
    return { recommendations: [] };
  }

  const cartCategories = new Set(
    order.items.map((item) => menu.find((m) => m.id === item.id)?.category).filter(Boolean)
  );
  const hasDrink = [...cartCategories].some((c) => DRINK_CATEGORIES.includes(c));
  const hasFood = [...cartCategories].some((c) => FOOD_CATEGORIES.includes(c));

  let preferred = candidates;
  if (hasDrink && !hasFood) {
    preferred = candidates.filter((item) => FOOD_CATEGORIES.includes(item.category));
  } else if (hasFood && !hasDrink) {
    preferred = candidates.filter((item) => DRINK_CATEGORIES.includes(item.category));
  }
  if (preferred.length === 0) {
    preferred = candidates;
  }

  const picks = preferred.slice(0, 2);
  picks.forEach((item) => order.suggestedItemIds.push(item.id));

  return {
    recommendations: picks.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      description: item.description,
      price: item.price,
    })),
  };
}

function getActivePromotions() {
  const promotions = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "promotions.json"), "utf8"));
  return promotions.filter((promo) => promo.active);
}

function isHappyHourWindow(date = new Date()) {
  const day = date.getDay();
  const hour = date.getHours();
  return day >= 1 && day <= 5 && hour >= 14 && hour < 16;
}

function checkPromotionEligibility(promo, order, menu) {
  if (promo.id === "happy-hour") {
    const hasHotCoffee = order.items.some((item) => menu.find((m) => m.id === item.id)?.category === "coffee");
    if (!hasHotCoffee) {
      return { eligible: false, reason: "Requires at least one hot coffee item in the order." };
    }
    if (!isHappyHourWindow()) {
      return { eligible: false, reason: "Only valid on weekdays between 2:00pm and 4:00pm." };
    }
    return { eligible: true };
  }
  if (promo.id === "student-discount") {
    if (order.items.length === 0) {
      return { eligible: false, reason: "The order is empty." };
    }
    return { eligible: true, note: "Customer must show a valid student ID at pickup/register." };
  }
  return { eligible: false, reason: "This promotion isn't currently available." };
}

function applyPromotion(input, order) {
  const { promotionId } = input || {};
  const menu = getMenu();
  const activePromotions = getActivePromotions();

  if (!promotionId) {
    const recommendations = activePromotions
      .map((promo) => ({ promo, elig: checkPromotionEligibility(promo, order, menu) }))
      .filter(({ elig }) => elig.eligible)
      .map(({ promo, elig }) => ({
        id: promo.id,
        name: promo.name,
        rule: promo.rule,
        discount: promo.discount,
        note: elig.note,
      }));
    return { eligiblePromotions: recommendations };
  }

  const promo = activePromotions.find((p) => p.id === promotionId);
  if (!promo) {
    return { error: `"${promotionId}" is not a recognized, active promotion. Never apply or invent a discount code that isn't in data/promotions.json.` };
  }

  if (order.discount) {
    return { error: `"${order.discount.name}" is already applied, and promotions can't be combined.` };
  }

  const elig = checkPromotionEligibility(promo, order, menu);
  if (!elig.eligible) {
    return { error: elig.reason };
  }

  order.discount = { id: promo.id, name: promo.name, discount: promo.discount };
  order.total = computeOrderTotal(order, menu);

  return { applied: order.discount, note: elig.note, cart: { items: order.items, total: order.total } };
}

function setPickupDetails(input, order) {
  const { name, pickupTime } = input || {};

  if (name !== undefined) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) {
      return { error: "Name cannot be empty." };
    }
    order.customerDetails.name = trimmed;
    order.orderType = "pickup";
  }

  if (pickupTime !== undefined) {
    const trimmed = typeof pickupTime === "string" ? pickupTime.trim() : "";
    order.customerDetails.pickupTime = trimmed || undefined;
    order.orderType = "pickup";
  }

  const missing = [];
  if (!order.customerDetails.name) missing.push("name");

  return {
    orderType: order.orderType,
    name: order.customerDetails.name || null,
    pickupTime: order.customerDetails.pickupTime || null,
    missing,
  };
}

function setDeliveryDetails(input, order) {
  const { name, phone, address, apartment, instructions, confirmed } = input || {};
  let anyFieldChanged = false;

  const requiredFields = { name, phone, address };
  for (const [field, value] of Object.entries(requiredFields)) {
    if (value !== undefined) {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!trimmed) {
        return { error: `${field} cannot be empty.` };
      }
      order.customerDetails[field] = trimmed;
      order.orderType = "delivery";
      anyFieldChanged = true;
    }
  }

  if (apartment !== undefined) {
    const trimmed = typeof apartment === "string" ? apartment.trim() : "";
    order.customerDetails.apartment = trimmed || undefined;
    order.orderType = "delivery";
    anyFieldChanged = true;
  }

  if (instructions !== undefined) {
    const trimmed = typeof instructions === "string" ? instructions.trim() : "";
    order.customerDetails.instructions = trimmed || undefined;
    order.orderType = "delivery";
    anyFieldChanged = true;
  }

  if (anyFieldChanged) {
    order.customerDetails.addressConfirmed = false;
  }

  const missing = ["name", "phone", "address"].filter((field) => !order.customerDetails[field]);

  if (confirmed === true && !anyFieldChanged) {
    if (missing.length > 0) {
      return { error: `Can't confirm yet — still missing: ${missing.join(", ")}.` };
    }
    order.customerDetails.addressConfirmed = true;
  }

  return {
    orderType: order.orderType,
    name: order.customerDetails.name || null,
    phone: order.customerDetails.phone || null,
    address: order.customerDetails.address || null,
    apartment: order.customerDetails.apartment || null,
    instructions: order.customerDetails.instructions || null,
    missing,
    addressConfirmed: !!order.customerDetails.addressConfirmed,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// The single deterministic price calculation for the whole order. Only ever
// reads real menu prices/quantities and the applied promotion — the model
// never computes or states a dollar figure that didn't come from here.
function computeOrderBreakdown(order, menu) {
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const afterDiscount = computeOrderTotal(order, menu);
  const discountAmount = round2(subtotal - afterDiscount);
  const tax = round2(afterDiscount * TAX_RATE);
  const deliveryFee = order.orderType === "delivery" ? DELIVERY_FEE : 0;
  const grandTotal = round2(afterDiscount + tax + deliveryFee);

  return {
    subtotal: round2(subtotal),
    discount: order.discount ? { name: order.discount.name, amount: discountAmount } : null,
    afterDiscount: round2(afterDiscount),
    taxRate: TAX_RATE,
    tax,
    deliveryFee,
    grandTotal,
  };
}

function getOrderTotal(order) {
  if (order.items.length === 0) {
    return { error: "The order is empty — there's nothing to total yet." };
  }
  return computeOrderBreakdown(order, getMenu());
}

function getOrderSummary(order) {
  if (order.items.length === 0) {
    return { error: "The order is empty — there's nothing to summarize yet." };
  }

  const menu = getMenu();

  const items = order.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    size: item.size,
    options: item.options,
  }));

  let fulfillment = { type: order.orderType };
  if (order.orderType === "pickup") {
    fulfillment = {
      type: "pickup",
      name: order.customerDetails.name || null,
      pickupTime: order.customerDetails.pickupTime || null,
    };
  } else if (order.orderType === "delivery") {
    fulfillment = {
      type: "delivery",
      name: order.customerDetails.name || null,
      phone: order.customerDetails.phone || null,
      address: order.customerDetails.address || null,
      apartment: order.customerDetails.apartment || null,
      instructions: order.customerDetails.instructions || null,
      addressConfirmed: !!order.customerDetails.addressConfirmed,
    };
  }

  const promotion = order.discount ? { id: order.discount.id, name: order.discount.name } : null;

  return {
    items,
    fulfillment,
    promotion,
    pricing: computeOrderBreakdown(order, menu),
  };
}

function confirmOrder(input, order) {
  const { confirmed } = input || {};

  if (confirmed !== true) {
    return { error: "Order not confirmed. Only call this after the customer has explicitly confirmed the order summary." };
  }

  if (order.confirmed) {
    return { error: "This order was already confirmed and saved.", orderId: order.orderId, status: order.status };
  }

  if (order.items.length === 0) {
    return { error: "Cannot confirm an empty order." };
  }

  if (!order.orderType) {
    return { error: "Fulfillment type (pickup or delivery) hasn't been set yet." };
  }

  if (order.orderType === "pickup" && !order.customerDetails.name) {
    return { error: "Pickup name is still missing." };
  }

  if (order.orderType === "delivery") {
    const missingDelivery = ["name", "phone", "address"].filter((field) => !order.customerDetails[field]);
    if (missingDelivery.length > 0) {
      return { error: `Delivery details still missing: ${missingDelivery.join(", ")}.` };
    }
    if (!order.customerDetails.addressConfirmed) {
      return { error: "The delivery address hasn't been explicitly confirmed by the customer yet." };
    }
  }

  const summary = getOrderSummary(order);
  const record = {
    orderId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status: "NEW",
    items: summary.items,
    fulfillment: summary.fulfillment,
    promotion: summary.promotion,
    pricing: summary.pricing,
  };

  const orders = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8"));
  orders.push(record);
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2) + "\n");

  order.confirmed = true;
  order.status = "confirmed";
  order.orderId = record.orderId;

  return { saved: true, orderId: record.orderId, timestamp: record.timestamp, status: record.status };
}

function runTool(name, input, order) {
  if (name === "getMenu") return getMenu();
  if (name === "addItemToCart") return addItemToCart(input, order);
  if (name === "modifyItem") return modifyItem(input, order);
  if (name === "removeItem") return removeItem(input, order);
  if (name === "viewCart") return viewCart(order);
  if (name === "getRecommendations") return getRecommendations(order);
  if (name === "applyPromotion") return applyPromotion(input, order);
  if (name === "setPickupDetails") return setPickupDetails(input, order);
  if (name === "setDeliveryDetails") return setDeliveryDetails(input, order);
  if (name === "getOrderTotal") return getOrderTotal(order);
  if (name === "getOrderSummary") return getOrderSummary(order);
  if (name === "confirmOrder") return confirmOrder(input, order);
  return { error: `Unknown tool: ${name}` };
}

// In-memory order state per chat session. Lost on server restart — fine for
// local development, but must be replaced with real storage before production.
const orderSessions = new Map();

function createOrderState() {
  return {
    items: [], // each: { id, name, quantity, size, options, price }
    orderType: null, // "pickup" | "delivery"
    customerDetails: {}, // name, phone, address, pickupTime, etc.
    discount: null, // { id, name, value } of an applied promotion
    total: 0,
    confirmed: false,
    status: "building", // "building" | "confirmed"
    suggestedItemIds: [], // ids already recommended this session — never re-suggested
  };
}

function getOrCreateSession(requestedId) {
  if (requestedId && orderSessions.has(requestedId)) {
    return { sessionId: requestedId, order: orderSessions.get(requestedId) };
  }
  const sessionId = crypto.randomUUID();
  const order = createOrderState();
  orderSessions.set(sessionId, order);
  return { sessionId, order };
}

// Gates the staff dashboard and orders API behind a single shared password
// (HTTP Basic Auth). Fails closed if STAFF_PASSWORD isn't configured, rather
// than silently letting everyone in.
function requireStaffAuth(req, res, next) {
  if (!STAFF_PASSWORD) {
    return res.status(500).send("Dashboard is not configured: set STAFF_PASSWORD in .env.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    const expected = Buffer.from(STAFF_PASSWORD);
    const actual = Buffer.from(password);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Tea Time Cafe Staff Dashboard"');
  return res.status(401).send("Authentication required.");
}

const app = express();
app.use(express.json());

app.get("/dashboard.html", requireStaffAuth, (req, res) => {
  res.sendFile(path.join(ROOT, "frontend", "dashboard.html"));
});

app.use(express.static(path.join(ROOT, "frontend")));

app.post("/api/chat", async (req, res) => {
  const { message, history, sessionId: requestedSessionId } = req.body || {};

  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "'message' is required" });
  }

  const { sessionId, order } = getOrCreateSession(requestedSessionId);
  const messages = [...(Array.isArray(history) ? history : []), { role: "user", content: message }];

  try {
    let response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((block) => block.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: toolUseBlocks.map((block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(runTool(block.name, block.input, order)),
        })),
      });

      response = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    }

    const reply = response.content.find((block) => block.type === "text")?.text || FALLBACK_REPLY;
    res.json({ reply, sessionId });
  } catch (err) {
    console.error("Claude API request failed:", err.message);
    res.json({ reply: FALLBACK_REPLY, sessionId });
  }
});

app.get("/api/orders", requireStaffAuth, (req, res) => {
  const orders = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8"));
  res.json({ orders });
});

app.post("/api/orders/:orderId/status", requireStaffAuth, (req, res) => {
  const { status } = req.body || {};

  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
  }

  const orders = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8"));
  const order = orders.find((o) => o.orderId === req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: `No order with id "${req.params.orderId}".` });
  }

  order.status = status;
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2) + "\n");
  res.json({ order });
});

app.listen(PORT, () => {
  console.log(`Tea Time Cafe backend listening on port ${PORT}`);
});
