import express from "express";
import asyncHandler from "express-async-handler";

import { getLatestEvents, getLatestKind1, reloadWidgets } from "./widgets.js";
import { createVersionChecker } from "./version.js";
import { createPreviewer } from "./preview.js";
import { deleteEventsNotBy } from "./relay-db.js";

const getPreview = createPreviewer();

const getVersion = createVersionChecker();

const router = express.Router();

router.get('/', (request, response) => {
  response.json({message: "Pura Vida!"})
})

router.get("/connectionStatus", asyncHandler(async (request, response) => {
  const relayManager = request.app.get("relayManager");
  const status = relayManager.getConnectionStatus();

  response.send(status);
}));

// Every saved version of each synced account's profile and relay list, oldest first
router.get("/history", asyncHandler(async (request, response) => {
  const relayManager = request.app.get("relayManager");
  response.json(relayManager.history.versions(relayManager.pubkeys));
}));

// Share card for a link in a post: { preview: { url, title, description, image, siteName } or null }
router.get("/preview", asyncHandler(async (request, response) => {
  let preview;
  try {
    preview = await getPreview(String(request.query.url || ""));
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
  response.set("Cache-Control", "private, max-age=3600").json({ preview });
}));

// Deletes everything saved by accounts that aren't synced ("Others"), or only
// one such account's events with { author }
router.post("/delete-others", asyncHandler(async (request, response) => {
  const relayManager = request.app.get("relayManager");
  const status = relayManager.getConnectionStatus();
  if (status.identifiers.length === 0) {
    return response.status(409).json({ error: "No accounts are synced, so there is nothing that counts as other accounts." });
  }
  if (status.identifiers.some(account => !account.pubkey)) {
    return response.status(409).json({
      error: "An account is still being looked up. Try again when every account has loaded, so its backup isn't deleted.",
    });
  }
  try {
    const deleted = deleteEventsNotBy(relayManager.pubkeys, { author: request.body?.author });
    // The Umbrel widgets keep their own copy of the newest events
    if (deleted) reloadWidgets();
    response.json({ deleted });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}));

// Running version, and the latest version in the saltedlolly App Store (for the update notice)
router.get("/version", asyncHandler(async (request, response) => {
  response.json(await getVersion());
}));

router.post("/identifier", asyncHandler(async (request, response) => {
  const relayManager = request.app.get("relayManager");
  const identifier = request.body.identifier;
  await relayManager.addIdentifier(identifier);

  response.json({success: true})
}));

router.delete("/identifier", asyncHandler(async (request, response) => {
  const relayManager = request.app.get("relayManager");
  // the identifier to stop syncing; with none given, all accounts are removed
  await relayManager.removeIdentifier(request.body?.identifier);

  response.json({ success: true });
}));

// TODO: consider moving widget routes to a separate file/router
router.get("/widgets/latest-events", asyncHandler(async (request, response) => {
  const widgetData = getLatestEvents();

  response.json(widgetData);
}));

router.get("/widgets/latest-kind1", asyncHandler(async (request, response) => {
  const widgetData = getLatestKind1();

  response.json(widgetData);
}
));

export const routes = router;
