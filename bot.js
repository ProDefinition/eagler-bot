/**
 * FIREBASE REST TESTER - PERSISTENT VERSION
 * No SDKs. No Deletions. Just pure HTTP.
 */

const firebaseConfig = {
  databaseURL: "https://polaris-358ae-default-rtdb.firebaseio.com",
};

// We'll write to this node. It will stay there until you manually delete it.
const DB_PATH = "persistent_debug_node";
const FULL_URL = `${firebaseConfig.databaseURL}/${DB_PATH}.json`;

async function runTests() {
  console.log("🚀 Starting Persistent Firebase Write...");
  console.log(`📡 Target URL: ${FULL_URL}\n`);

  try {
    // --- STEP 1: INITIAL WRITE (PUT) ---
    console.log("--- [STEP 1] Writing Initial Data ---");
    const initialPayload = {
      status: "initialized",
      message: "This data should stay in the console!",
      last_updated: new Date().toLocaleString(),
      connection_type: "Pure REST (Fetch)"
    };

    const writeRes = await fetch(FULL_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initialPayload)
    });

    await handleResponse(writeRes, "Initial Write");

    // --- STEP 2: PARTIAL UPDATE (PATCH) ---
    console.log("\n--- [STEP 2] Updating Status (PATCH) ---");
    const updatePayload = { 
      status: "successfully_persisted",
      note: "I added this field without deleting the others!"
    };
    
    const updateRes = await fetch(FULL_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatePayload)
    });

    await handleResponse(updateRes, "Partial Update");

    // --- STEP 3: FINAL VERIFICATION (GET) ---
    console.log("\n--- [STEP 3] Final Read-Back ---");
    const readRes = await fetch(FULL_URL);
    await handleResponse(readRes, "Verification Read");

    console.log("\n✅ DONE! You can now check your Firebase Console.");
    console.log(`🔗 Look for the "${DB_PATH}" key at: ${firebaseConfig.databaseURL}`);

  } catch (err) {
    console.error("\n❌ SCRIPT ERROR:", err.message);
  }
}

/**
 * Enhanced Debug Logger
 */
async function handleResponse(res, label) {
  const data = await res.json();
  
  if (res.ok) {
    console.log(`[${label}] Status: ${res.status} OK`);
    console.log(`[${label}] Data:`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${label}] ❌ FAILED!`);
    console.log(`[${label}] Error Status: ${res.status}`);
    console.log(`[${label}] Error Body:`, data);
  }
}

runTests();
