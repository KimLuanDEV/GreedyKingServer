import express from "express";
import cors from "cors";
import admin from "firebase-admin";

/** ---------- ENV ----------
 * FIREBASE_PROJECT_ID=...
 * FIREBASE_CLIENT_EMAIL=...@...gserviceaccount.com
 * FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
 * ADMIN_API_KEY=your-strong-admin-key
 * CORS_ORIGINS=https://your-frontend.example
 * INIT_BALANCE=10000
 */

const app = express();
app.use(express.json());

// CORS
const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : true }));

// Admin init
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
    });
}
const db = admin.firestore();

// ===== Middlewares =====
async function authUser(req, res, next) {
    try {
        const h = req.headers.authorization || "";
        const token = h.startsWith("Bearer ") ? h.slice(7) : null;
        if (!token) return res.status(401).json({ ok: false, error: "Missing ID token" });
        const decoded = await admin.auth().verifyIdToken(token);
        req.uid = decoded.uid;
        next();
    } catch {
        res.status(401).json({ ok: false, error: "Invalid ID token" });
    }
}
function authAdmin(req, res, next) {
    const key = req.headers["x-admin-key"];
    if (!key || key !== process.env.ADMIN_API_KEY) return res.status(403).json({ ok: false, error: "Admin key required" });
    next();
}
function doorGroups() {
    return {
        rau: ["Chua", "Cải", "Ngô", "Rốt"],
        thit: ["Mỳ", "Xiên", "Đùi", "Bò"],
        all: ["Chua", "Cải", "Ngô", "Rốt", "Mỳ", "Xiên", "Đùi", "Bò"]
    };
}

// ===== APIs =====

// A) Khởi tạo user lần đầu (hoặc trả về user hiện tại)
app.post("/me/init", authUser, async (req, res) => {
    try {
        const uid = req.uid;
        const initBalance = parseInt(process.env.INIT_BALANCE || "10000", 10);
        const userRef = db.collection("users").doc(uid);
        const snap = await userRef.get();
        if (!snap.exists) {
            await userRef.set({
                balance: initBalance,
                name: req.body?.name || ("User_" + uid.slice(0, 6)),
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        const doc = await userRef.get();
        res.json({ ok: true, user: { id: uid, ...doc.data() } });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// B) Admin mở phiên mới
app.post("/round/open", authAdmin, async (req, res) => {
    try {
        const roundId = (req.body?.roundId) || String(Date.now());
        const roundRef = db.collection("rounds").doc(roundId);
        await roundRef.set({
            status: "betting",
            result: null,
            jackpot: 0,
            startedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ ok: true, roundId });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// C) User đặt cược
app.post("/bet", authUser, async (req, res) => {
    try {
        const uid = req.uid;
        const { roundId, tpl } = req.body || {};
        if (!roundId || !tpl || typeof tpl !== "object")
            return res.status(400).json({ ok: false, error: "roundId & tpl required" });

        const roundRef = db.collection("rounds").doc(roundId);
        const userRef = db.collection("users").doc(uid);
        const betRef = roundRef.collection("bets").doc(uid);

        await db.runTransaction(async (tx) => {
            const [roundSnap, userSnap] = await Promise.all([tx.get(roundRef), tx.get(userRef)]);
            if (!roundSnap.exists) throw new Error("Round not found");
            const round = roundSnap.data();
            if (round.status !== "betting") throw new Error("Round is locked");

            const totalBet = Object.values(tpl).reduce((a, b) => a + (+b || 0), 0);
            if (totalBet <= 0) throw new Error("Empty bet");

            if (!userSnap.exists) throw new Error("User not found");
            const balance = userSnap.data().balance || 0;
            if (balance < totalBet) throw new Error("Insufficient balance");

            tx.update(userRef, { balance: admin.firestore.FieldValue.increment(-totalBet) });
            tx.set(betRef, {
                tpl,
                totalBet,
                placedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });

        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// D) Admin spin (khoá phiên, sinh kết quả, trả thưởng, cập nhật jackpot, lưu history)
app.post("/spin", authAdmin, async (req, res) => {
    try {
        const { roundId, odds } = req.body || {};
        if (!roundId) return res.status(400).json({ ok: false, error: "roundId required" });

        const roundRef = db.collection("rounds").doc(roundId);
        const roundSnap = await roundRef.get();
        if (!roundSnap.exists) return res.status(404).json({ ok: false, error: "Round not found" });
        const round = roundSnap.data();
        if (round.status === "settled") return res.json({ ok: true, result: round.result });

        // 1) Khoá
        await roundRef.update({ status: "locked" });

        // 2) Tính kết quả với xác suất
        const pSalad = odds?.salad ?? 0.05;
        const pPizza = odds?.pizza ?? 0.05;
        const { rau, thit, all } = doorGroups();
        const r = Math.random();
        let result;
        if (r < pSalad) result = "SALAD";
        else if (r < pSalad + pPizza) result = "PIZZA";
        else result = all[Math.floor(Math.random() * all.length)];

        // 3) Payout
        const betsSnap = await roundRef.collection("bets").get();
        let jackpotIncrease = 0;
        const batch = db.batch();

        for (const doc of betsSnap.docs) {
            const uid = doc.id;
            const { tpl = {}, totalBet = 0 } = doc.data();

            // Hệ số ví dụ:
            let win = 0;
            if (result === "SALAD") {
                win = rau.reduce((s, k) => s + (+tpl[k] || 0), 0);
            } else if (result === "PIZZA") {
                win = thit.reduce((s, k) => s + (+tpl[k] || 0), 0);
            } else {
                win = (+tpl[result] || 0) * 2;
            }

            jackpotIncrease += Math.max(0, totalBet - win);
            const userRef = db.collection("users").doc(uid);
            if (win > 0) batch.update(userRef, { balance: admin.firestore.FieldValue.increment(win) });
        }

        // 4) Jackpot + round + history
        const jpRef = db.collection("jackpot").doc("state");
        batch.set(jpRef, {
            value: admin.firestore.FieldValue.increment(jackpotIncrease),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        batch.update(roundRef, {
            result,
            status: "settled",
            endedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const histRef = db.collection("results").doc("history").collection("items").doc();
        batch.set(histRef, {
            roundId, result, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();

        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get("/", (_, res) => res.send("Greedy Server OK"));
app.listen(process.env.PORT || 3000, () => console.log("Server up"));
