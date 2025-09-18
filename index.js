// index.js
const express = require("express");
const admin = require("firebase-admin");
const { Parser } = require("json2csv"); // for CSV export
const PDFDocument = require("pdfkit");   // for PDF export
const stream = require("stream");
// Load service account credentials from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();
app.use(express.json());

// ===== Health Check =====
app.get("/", (req, res) => res.send("GCC Fellowship Backend is running ✅"));

// ===== Leader Registration =====
app.post("/register-leader", async (req, res) => {
  try {
    const { name, phone, fellowship, lineage } = req.body;

    const existing = await db.collection("leaders")
      .where("fellowship", "==", fellowship)
      .get();
    if (!existing.empty) return res.status(400).json({ error: "Fellowship name already exists" });

    const docRef = db.collection("leaders").doc();
    const passcode = generatePasscode(12);

    await docRef.set({ name, phone, fellowship, lineage, passcode, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, message: "Leader registered", passcode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Leader Login =====
app.post("/leader-login", async (req, res) => {
  try {
    const { fellowship, passcode } = req.body;
    const snapshot = await db.collection("leaders")
      .where("fellowship", "==", fellowship)
      .where("passcode", "==", passcode)
      .get();

    if (snapshot.empty) return res.status(401).json({ error: "Invalid credentials" });
    const leader = snapshot.docs[0].data();
    res.json({ ok: true, leader });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Add Member =====
app.post("/leader/:leaderId/add-member", async (req, res) => {
  try {
    const { leaderId } = req.params;
    const { name, phone, classStopped, residence, ageRange } = req.body;

    const membersRef = db.collection("members");
    const existing = await membersRef
      .where("leaderId", "==", leaderId)
      .where("phone", "==", phone)
      .get();
    if (!existing.empty) return res.status(400).json({ error: "Member already exists" });

    await membersRef.add({
      leaderId,
      name,
      phone,
      classStopped,
      residence,
      ageRange,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ok: true, message: "Member added" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Get Members by Leader =====
app.get("/leader/:leaderId/members", async (req, res) => {
  try {
    const { leaderId } = req.params;
    const snapshot = await db.collection("members")
      .where("leaderId", "==", leaderId)
      .get();
    const members = snapshot.docs.map(doc => doc.data());
    res.json({ ok: true, members });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Record Attendance =====
app.post("/leader/:leaderId/attendance", async (req, res) => {
  try {
    const { leaderId } = req.params;
    const { presentMemberIds, didNotMeet } = req.body; // presentMemberIds = array of member doc IDs

    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    if (didNotMeet) {
      await db.collection("attendance").add({ leaderId, date: today, didNotMeet: true });
      return res.json({ ok: true, message: "Marked as did not meet" });
    }

    for (const memberId of presentMemberIds) {
      await db.collection("attendance").add({
        leaderId,
        memberId,
        present: true,
        date: today
      });
    }

    res.json({ ok: true, message: "Attendance recorded" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Admin: View Fellowships Meetups =====
app.get("/admin/meetups/:date", async (req, res) => {
  try {
    const { date } = req.params; // YYYY-MM-DD
    const snapshot = await db.collection("attendance").where("date", "==", date).get();
    const meetups = snapshot.docs.map(doc => doc.data());
    res.json({ ok: true, meetups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Admin: Export Members or Attendance as CSV =====
app.get("/export/csv/:collection", async (req, res) => {
  try {
    const { collection } = req.params;
    const snapshot = await db.collection(collection).get();
    const data = snapshot.docs.map(doc => doc.data());
    const parser = new Parser();
    const csv = parser.parse(data);

    res.header("Content-Type", "text/csv");
    res.attachment(`${collection}.csv`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Admin: Check Fellowships that did not meet this week =====
app.get("/admin/missed-meetups", async (req, res) => {
  try {
    // Get all leaders/fellowships
    const leadersSnapshot = await db.collection("leaders").get();
    const leaders = leadersSnapshot.docs.map(doc => ({ leaderId: doc.id, fellowship: doc.data().fellowship }));

    // Get start of current week (Monday)
    const today = new Date();
    const day = today.getDay(); // Sunday = 0, Monday = 1 ...
    const diffToMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(today);
    monday.setDate(today.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);

    // Get attendance records for the week
    const attendanceSnapshot = await db.collection("attendance")
      .where("date", ">=", monday.toISOString().split("T")[0])
      .get();

    const attendedLeaders = new Set();
    attendanceSnapshot.docs.forEach(doc => {
      const data = doc.data();
      attendedLeaders.add(data.leaderId);
    });

    // Find leaders/fellowships that did NOT meet
    const missed = leaders.filter(l => !attendedLeaders.has(l.leaderId));

    res.json({ ok: true, missedFellowships: missed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Admin: Export Members as PDF =====
app.get("/export/pdf/members/:leaderId", async (req, res) => {
  try {
    const { leaderId } = req.params;
    const snapshot = await db.collection("members").where("leaderId", "==", leaderId).get();
    const doc = new PDFDocument();
    const bufferStream = new stream.PassThrough();

    doc.pipe(bufferStream);
    doc.fontSize(16).text(`Members for Leader: ${leaderId}`, { align: "center" });
    doc.moveDown();

    snapshot.docs.forEach((d, i) => {
      const m = d.data();
      doc.fontSize(12).text(`${i + 1}. ${m.name} | Phone: ${m.phone} | Class: ${m.classStopped} | Residence: ${m.residence} | Age: ${m.ageRange}`);
    });

    doc.end();
    res.setHeader("Content-disposition", `attachment; filename=members_${leaderId}.pdf`);
    res.setHeader("Content-type", "application/pdf");
    bufferStream.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Helper: generate random passcode =====
function generatePasscode(len = 12) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
