import express from "express";
import asyncHandler from "express-async-handler";

import { getLatestEvents, getLatestKind1 } from "./widgets.js";
import { createVersionChecker } from "./version.js";

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
