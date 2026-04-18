/**
 * FIREBASE REALTIME DATABASE - ZERO SDK TESTER
 * Uses standard HTTP REST logic.
 */

const firebaseConfig = {
  databaseURL: "https://polaris-358ae-default-rtdb.firebaseio.com",
};

// We append .json to the end of every path. That is the "secret sauce".
const DB_PATH = "debug_test_node";
const FULL_URL = `${firebaseConfig.databaseURL}/${DB_PATH}.json`;

async function runTests() {
  console.log("🚀 Starting Firebase REST API Debug Session...");
  console.log(`📡 Target URL: ${FULL_URL}\n`);

  // --- TEST 1: WRITE (PUT) ---
  // PUT overwrites the entire node at that path.
  try {
    console.log("--- [TEST 1] Writing Data (PUT) ---");
    const payload = {
      status: "online",
      message: "Hello from Node.js vanilla fetch!",
      timestamp: new Date().toISOString()
    };

    console.log("DEBUG: Sending Payload:", JSON.stringify(payload));
    
    const response = await fetch(FULL_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    await handleResponse(response);
  } catch (err) {
    console.error("❌ Critical Error in Test 1:", err.message);
  }

  // --- TEST 2: UPDATE (PATCH) ---
  // PATCH only changes the specific fields you send.
  try {
    console.log("\n--- [TEST 2] Updating Data (PATCH) ---");
    const updatePayload = { status: "testing_complete" };
    
    const response = await fetch(FULL_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatePayload)
    });

    await handleResponse(response);
  } catch (err) {
    console.error("❌ Critical Error in Test 2:", err.message);
  }

  // --- TEST 3: READ (GET) ---
  try {
    console.log("\n--- [TEST 3] Reading Data (GET) ---");
    const response = await fetch(FULL_URL);
    await handleResponse(response);
  } catch (err) {
    console.error("❌ Critical Error in Test 3:", err.message);
  }

  // --- TEST 4: DELETE ---
  try {
    console.log("\n--- [TEST 4] Deleting Test Node (DELETE) ---");
    const response = await fetch(FULL_URL, { method: 'DELETE' });
    
    if (response.ok) {
      console.log("✅ Success: Node deleted successfully.");
    } else {
      await handleResponse(response);
    }
  } catch (err) {
    console.error("❌ Critical Error in Test 4:", err.message);
  }

  console.log("\n🏁 Debug Session Finished.");
}

/**
 * Helper to log detailed response info
 */
async function handleResponse(res) {
  console.log(`DEBUG: Status: ${res.status} ${res.statusText}`);
  
  const data = await res.json();
  
  if (res.ok) {
    console.log("✅ Server Response Data:", data);
  } else {
    console.log("❌ Request Failed!");
    console.log("DEBUG: Error Detail:", data);
    
    if (res.status === 401 || res.status === 403) {
      console.warn("\n⚠️  PERMISSION DENIED: Check your Firebase Realtime Database Security Rules.");
      console.warn("If you haven't added Auth, your rules must be set to '.read': true, '.write': true.");
    }
  }
}

runTests();
