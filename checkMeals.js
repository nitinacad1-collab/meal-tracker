// checkMeals.js (DEBUG VERSION)

const axios = require("axios");
const twilio = require("twilio");

const PROJECT_ID = "meal-tracker-25c10";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.WHATSAPP_NUMBER_FROM;
const toNumber = process.env.PHONE_NUMBER;

const client = twilio(accountSid, authToken);

const MEAL_SCHEDULE_IST = {
  "Breakfast": "08:00",
  "Morning Snack": "10:30",
  "Lunch": "13:00",
  "Evening Snack": "16:30",
  "Dinner": "19:30",
  "Bedtime": "22:30"
};

const MEALS = Object.keys(MEAL_SCHEDULE_IST);

const firestoreQueryURL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;

function toIST(d) {
  const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
  return new Date(utc.getTime() + 5.5 * 3600 * 1000);
}

function parseMealTime(date, timeStr) {
  const [hh, mm] = timeStr.split(":").map(Number);
  const d = new Date(date.getTime());
  d.setHours(hh, mm, 0, 0);
  return d;
}

async function getTodayUploadedMeals() {
  console.log("🔍 DEBUG: Checking Firestore for today's uploaded meals...");

  const nowIST = toIST(new Date());
  const startIST = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());
  const startUTC = new Date(startIST - 5.5 * 3600 * 1000);

  const query = {
    structuredQuery: {
      from: [{ collectionId: "meals" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "timestamp" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { timestampValue: startUTC.toISOString() }
        }
      }
    }
  };

  try {
    const res = await axios.post(firestoreQueryURL, query);
    const meals = res.data
      .filter(x => x.document)
      .map(x => x.document.fields.meal.stringValue);

    console.log("📌 DEBUG: Meals uploaded today:", meals);
    return meals;

  } catch (err) {
    console.log("❌ Firestore error:", err.response?.data || err.message);
    return [];
  }
}

async function sendTwilioWhatsApp(meal) {
  console.log(`📨 DEBUG: Attempting Twilio WhatsApp for ${meal}...`);

  try {
    const msg = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      to:   `whatsapp:${toNumber}`,
      body: `Reminder: Please upload your ${meal} meal photo today.`
    });

    console.log("✅ Twilio message sent:", msg.sid);

  } catch (err) {
    console.log("❌ TWILIO ERROR:", err);
  }
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

(async function main() {

  console.log("\n============================");
  console.log("🔍 DEBUG START");
  console.log("⏱ IST Now:", toIST(new Date()));
  console.log("📌 Using PHONE_NUMBER:", toNumber);
  console.log("📌 Using FROM_NUMBER:", fromNumber);
  console.log("📌 TWILIO_ACCOUNT_SID present?", !!accountSid);
  console.log("📌 TWILIO_AUTH_TOKEN present?", !!authToken);
  console.log("============================\n");

  const uploaded = await getTodayUploadedMeals();

  const nowIST = toIST(new Date());
  const today = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());
  const dateStr = formatDate(nowIST);

  for (const meal of MEALS) {
    console.log("\n--------------------------------");
    console.log(`🍽 Meal: ${meal}`);

    const mealTime = parseMealTime(today, MEAL_SCHEDULE_IST[meal]);
    const reminderTime = new Date(mealTime.getTime() + 2 * 3600 * 1000);

    console.log("⏰ Meal time:", mealTime);
    console.log("⏱ Now IST:", nowIST);
    console.log("📌 Reminder time:", reminderTime);

    if (nowIST < reminderTime) {
      console.log(`⏸ Not due yet for: ${meal}`);
      continue;
    }

    if (uploaded.includes(meal)) {
      console.log(`📸 Already uploaded: ${meal}`);
      continue;
    }

    console.log(`🚀 SENDING REMINDER for ${meal}...`);
    await sendTwilioWhatsApp(meal);
  }

  console.log("\n✔ DEBUG FINISHED\n");
})();
