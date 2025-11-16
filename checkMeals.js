// checkMealsWithReminders.js
// Runs hourly via GitHub Actions

const axios = require("axios");
const twilio = require("twilio");

// ====== CONFIG FROM GITHUB SECRETS ======
const PROJECT_ID = "meal-tracker-25c10";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.WHATSAPP_NUMBER_FROM;   // +14155238886
const toNumber = process.env.PHONE_NUMBER;             // father's WhatsApp number
// ========================================

// Twilio client
const client = twilio(accountSid, authToken);

// Meal schedule in IST
const MEAL_SCHEDULE_IST = {
  "Breakfast": "08:00",
  "Morning Snack": "10:30",
  "Lunch": "13:00",
  "Evening Snack": "16:30",
  "Dinner": "19:30",
  "Bedtime": "22:30"
};

const MEALS = Object.keys(MEAL_SCHEDULE_IST);

const firestoreRunQueryUrl =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;

const firestoreCreateDocUrl = (collection) =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}`;

function toIST(d) {
  const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
  const ist = new Date(utc.getTime() + 5.5 * 3600 * 1000);
  return ist;
}

function parseTime(istDayDate, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const dt = new Date(istDayDate.getTime());
  dt.setHours(hh, mm, 0, 0);
  return dt;
}

async function getTodayUploadedMeals() {
  const nowIST = toIST(new Date());
  const startIST = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());
  const startUTC = new Date(startIST.getTime() - 5.5 * 3600 * 1000);
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
      }
    }
  };

  const res = await axios.post(firestoreRunQueryUrl, query);
  return res.data
    .filter(x => x.document)
    .map(x => x.document.fields.meal.stringValue);
}

async function reminderAlreadySent(mealName, dateStr) {
  const docId = `${dateStr}_${mealName.replace(/\s+/g, "_")}`;
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/reminders/${encodeURIComponent(docId)}`;
  try {
    await axios.get(url);
    return true;
  } catch (err) {
    return false;
  }
}

async function createReminderRecord(mealName, dateStr) {
  const docId = `${dateStr}_${mealName.replace(/\s+/g, "_")}`;
  const url = firestoreCreateDocUrl(`reminders?documentId=${encodeURIComponent(docId)}`);
  await axios.post(url, {
    fields: {
      meal: { stringValue: mealName },
      date: { stringValue: dateStr },
      sentAt: { timestampValue: new Date().toISOString() }
    }
  });
}

async function sendTwilioWhatsApp(mealName) {
  const message = `Reminder: Please upload your ${mealName} meal photo today.`;

  const result = await client.messages.create({
    from: `whatsapp:${fromNumber}`,
    to:   `whatsapp:${toNumber}`,
    body: message
  });

  console.log("WhatsApp message sent:", result.sid);
}

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

(async function main() {
  try {
    const uploadedMeals = await getTodayUploadedMeals();
    const nowIST = toIST(new Date());
    const dateStr = formatDate(nowIST);
    const istDay = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());

    for (const meal of MEALS) {
      const mealTime = parseTime(istDay, MEAL_SCHEDULE_IST[meal]);
      const reminderTime = new Date(mealTime.getTime() + 2 * 3600 * 1000);

      if (nowIST < reminderTime) continue;
      if (uploadedMeals.includes(meal)) continue;

      const sent = await reminderAlreadySent(meal, dateStr);
      if (sent) continue;

      console.log(`Sending reminder for ${meal}...`);
      await sendTwilioWhatsApp(meal);  
      await createReminderRecord(meal, dateStr);

      await new Promise(r => setTimeout(r, 1500));
    }

    console.log("Check completed.");
  } catch (e) {
    console.error("Fatal error:", e);
  }
})();
