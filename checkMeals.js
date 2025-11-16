// checkMealsWithReminders.js
// Run from GitHub Actions (hourly). Uses Firestore REST API (no auth assumed).
// IMPORTANT: If your Firestore rules require auth, use a service account / google auth flow instead.

const axios = require("axios");

// ====== CONFIG - EDIT BEFORE USE ======
const PHONE_NUMBER = "+916302257743";   // Replace with your father's number
const PROJECT_ID = "meal-tracker-25c10"; // Your Firebase project id
// ======================================

// Meal schedule in IST (24h). Edit to your father's meal times.
const MEAL_SCHEDULE_IST = {
  "Breakfast": "08:00",
  "Morning Snack": "10:30",
  "Lunch": "13:00",
  "Evening Snack": "16:30",
  "Dinner": "19:30",
  "Bedtime": "22:30"
};

const MEALS = Object.keys(MEAL_SCHEDULE_IST);

const firestoreRunQueryUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
const firestoreCreateDocUrl = (collection) =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}`;

function toIST(d) {
  // returns a Date object in IST equivalent (local JS Date forced to IST)
  // We'll compute offsets manually: IST = UTC + 5.5h
  const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
  const ist = new Date(utc.getTime() + 5.5 * 3600 * 1000);
  return ist;
}

function parseTimeStringToISTDate(dayDate, timeString) {
  // dayDate is Date representing the day in IST midnight
  // timeString like "08:00"
  const [hh, mm] = timeString.split(":").map(Number);
  const dt = new Date(dayDate.getTime());
  dt.setHours(hh, mm, 0, 0);
  return dt;
}

async function getTodayUploadedMeals() {
  // Query Firestore documents in 'meals' where timestamp >= todayStartIST
  // Using runQuery structured query
  const nowUTC = new Date();
  const nowIST = toIST(nowUTC);
  const todayStartIST = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate(), 0, 0, 0, 0);
  // Convert start IST back to RFC3339 UTC (Firestore timestamp expects RFC3339 in UTC)
  const startUTC = new Date(todayStartIST.getTime() - 5.5 * 3600 * 1000);
  const startISO = startUTC.toISOString();

  const query = {
    structuredQuery: {
      from: [{ collectionId: "meals" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "timestamp" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { timestampValue: startISO }
        }
      },
      orderBy: [{ field: { fieldPath: "timestamp" }, direction: "ASCENDING" }]
    }
  };

  try {
    const res = await axios.post(firestoreRunQueryUrl, query, { timeout: 15000 });
    const uploadedMeals = res.data
      .filter(item => item.document)
      .map(item => {
        const fields = item.document.fields || {};
        const meal = fields.meal && fields.meal.stringValue ? fields.meal.stringValue : null;
        const ts = fields.timestamp && fields.timestamp.timestampValue ? fields.timestamp.timestampValue : null;
        return { meal, ts };
      })
      .filter(x => x.meal !== null);
    return uploadedMeals; // array of {meal, ts}
  } catch (err) {
    console.error("Error querying Firestore:", err.response?.data || err.message);
    throw err;
  }
}

async function reminderAlreadySent(mealName, dateStr) {
  // We will check collection 'reminders' for a doc with id pattern: date_meal
  // Using REST create/get: check if document exists by GET
  const docId = `${dateStr}_${mealName.replace(/\s+/g, "_")}`;
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/reminders/${encodeURIComponent(docId)}`;
  try {
    await axios.get(url);
    return true; // exists
  } catch (err) {
    if (err.response && err.response.status === 404) return false;
    console.error("Error checking reminder doc:", err.response?.data || err.message);
    // On doubt, treat as not sent to allow send (or you can skip)
    return false;
  }
}

async function createReminderRecord(mealName, dateStr) {
  const docId = `${dateStr}_${mealName.replace(/\s+/g, "_")}`;
  const url = `${firestoreCreateDocUrl(`reminders?documentId=${encodeURIComponent(docId)}`)}`;
  const body = {
    fields: {
      meal: { stringValue: mealName },
      date: { stringValue: dateStr },
      sentAt: { timestampValue: new Date().toISOString() }
    }
  };
  try {
    await axios.post(url, body);
    return true;
  } catch (err) {
    console.error("Error creating reminder doc:", err.response?.data || err.message);
    return false;
  }
}

async function sendWhatsAppReminder(missingMeals) {
  const text = encodeURIComponent(`Reminder: Please upload your ${missingMeals.join(", ")} meal photo today.`);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(PHONE_NUMBER)}&text=${text}`;
  try {
    await axios.get(url, { timeout: 15000 });
    console.log("WhatsApp reminder sent for:", missingMeals);
    return true;
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err.response?.data || err.message);
    return false;
  }
}

function getISTNow() {
  return toIST(new Date());
}

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

(async function main() {
  try {
    const uploaded = await getTodayUploadedMeals();
    const uploadedMeals = uploaded.map(x => x.meal);

    const istNow = getISTNow();
    const todayISTstart = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 0, 0, 0, 0);
    const dateStr = formatDateYYYYMMDD(todayISTstart);

    // For each meal, compute target reminder time
    for (const meal of MEALS) {
      const mealTimeStr = MEAL_SCHEDULE_IST[meal];
      if (!mealTimeStr) continue;

      const scheduledIST = parseTimeStringToISTDate(todayISTstart, mealTimeStr);
      // reminderTime = scheduled + 2 hours
      const reminderTime = new Date(scheduledIST.getTime() + 2 * 3600 * 1000);

      // If now is before reminderTime, skip for now
      if (istNow < reminderTime) {
        //console.log(`${meal} reminder not due yet. due at ${reminderTime}`);
        continue;
      }

      // If meal already uploaded, skip
      if (uploadedMeals.includes(meal)) {
        //console.log(`${meal} already uploaded today.`);
        continue;
      }

      // Check if reminder already sent
      const sent = await reminderAlreadySent(meal, dateStr);
      if (sent) {
        console.log(`Reminder already sent for ${meal} today.`);
        continue;
      }

      // Send reminder for this specific meal
      console.log(`Sending reminder for ${meal} (due at ${reminderTime.toISOString()} IST)`);
      const sentOk = await sendWhatsAppReminder([meal]);
      if (sentOk) {
        await createReminderRecord(meal, dateStr);
      }
      // Wait briefly between messages
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log("Check completed.");
  } catch (err) {
    console.error("Fatal error in reminder script:", err);
  }
})();
