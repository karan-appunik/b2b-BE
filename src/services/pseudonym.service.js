const crypto = require("crypto");

// A stable stand-in for an agent where analytics doesn't need to know who they
// are (spec §11.2). The same agent always gets the same code within a shop, the
// code can't be turned back into the agent without the key, and different shops
// get different codes for the same person.
function agentPseudonym(shop, agentId) {
  if (!agentId) return null;
  const key = process.env.ANALYTICS_PSEUDONYM_KEY || process.env.JWT_SECRET || "sparklayer";
  return "agt_" + crypto.createHmac("sha256", key).update(String(shop) + ":" + String(agentId)).digest("hex").slice(0, 12);
}

module.exports = { agentPseudonym };
