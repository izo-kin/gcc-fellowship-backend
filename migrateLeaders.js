// migrateLeaders.js
const admin = require("firebase-admin");

// Initialize Firebase Admin SDK with service account
// You need a service account JSON from Firebase console
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function migrateLeadersToAuth() {
  try {
    const snapshot = await admin.firestore().collection("leaders").get();
    const results = [];

    for (const doc of snapshot.docs) {
      const leaderId = doc.id;
      const data = doc.data();

      // synthetic email for Firebase Auth
      const email = `${leaderId}@leaders.gcc`;

      // use stored passcode if present, otherwise generate a new one
      let passcode = data.passcode;
      if (!passcode) passcode = generatePasscode(12);

      try {
        // try to create user with uid = leaderId
        const user = await admin.auth().createUser({
          uid: leaderId,
          email,
          password: passcode,
          displayName: data.name || "Leader",
        });

        // set custom claim
        await admin.auth().setCustomUserClaims(user.uid, {
          role: "leader",
          lineage: data.lineage || "unknown",
        });

        // update Firestore doc: remove raw passcode, add auth info
        await doc.ref.update({
          authUid: user.uid,
          email,
          passcodeMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        results.push({ leaderId, status: "migrated", email, passcode });
      } catch (err) {
        if (err.code === "auth/uid-already-exists") {
          results.push({ leaderId, status: "already exists" });
        } else {
          results.push({ leaderId, status: "error", error: err.message });
        }
      }
    }

    console.log("Migration Results:", results);
    return results;
  } catch (err) {
    console.error("Error migrating leaders:", err);
  }
}

// helper
function generatePasscode(len = 12) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
  return Array.from({ length: len }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

// Run the migration
migrateLeadersToAuth();
