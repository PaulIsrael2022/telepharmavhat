const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(bodyParser.json());

// User Schema
const userSchema = new mongoose.Schema({
  phoneNumber: { type: String, unique: true, required: true },
  firstName: { type: String, default: null },
  surname: { type: String, default: null },
  dateOfBirth: { type: Date, default: null },
  gender: {
    type: String,
    enum: ["MALE", "FEMALE"],
    default: null
  },
  medicalAidProvider: { type: String, default: null },
  medicalAidNumber: { type: String, default: null },
  scheme: { type: String, default: null },
  dependentNumber: { type: String, default: null },
  registrationStep: { type: Number, default: 1 },
  isRegistrationComplete: { type: Boolean, default: false },
  lastInteraction: { type: Date, default: Date.now },
  registrationData: {
    type: Map,
    of: String,
    default: () => new Map(),
  },
  preferences: {
    notificationPreference: {
      type: String,
      enum: ["SMS", "WhatsApp", "Email"],
      default: "WhatsApp",
    },
    language: { type: String, default: "English" },
  },
});

const User = mongoose.model("User", userSchema);

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// WhatsApp Cloud API Configuration
const WHATSAPP_API_URL = "https://graph.facebook.com/v18.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_CLOUD_API_FROM_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;

// Helper function to send WhatsApp messages
async function sendWhatsAppMessage(to, message, buttons = null) {
  const url = `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  const data = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "text",
    text: { body: message },
  };

  if (buttons && buttons.length > 0) {
    data.type = "interactive";
    data.interactive = {
      type: "button",
      body: { text: message },
      action: { buttons: buttons },
    };
  }

  try {
    await axios.post(url, data, { headers });
  } catch (error) {
    console.error("Error sending WhatsApp message:", error.response?.data || error.message);
  }
}

const registrationSteps = [
  { prompt: "Step 1: Please provide your first name.", field: "firstName" },
  { prompt: "Step 2: Please provide your surname.", field: "surname" },
  { prompt: "Step 3: Please provide your date of birth in the format DD/MM/YYYY.", field: "dateOfBirth" },
  { 
    prompt: "Step 4: Please select your gender:",
    field: "gender",
    options: ["MALE", "FEMALE"]
  },
  { 
    prompt: "Step 5: Please select your medical aid provider:",
    field: "medicalAidProvider",
    options: ["BOMAID", "PULA", "BPOMAS", "BOTSOGO"]
  },
  { prompt: "Step 6: Please provide your medical aid number.", field: "medicalAidNumber" },
  { prompt: "Step 7: Please specify your scheme (if applicable).", field: "scheme" },
  { prompt: "Step 8: If you have a dependent number, please provide it. Otherwise, type \"N/A\".", field: "dependentNumber" },
];

async function sendRegistrationPrompt(user) {
  const step = registrationSteps[user.registrationStep - 1];
  let buttons = [];

  if (step.options) {
    buttons = step.options.map(option => ({
      type: "reply",
      reply: { id: option, title: option.substring(0, 20) }
    }));
  }

  // Add "Back" button if not the first step and we have less than 3 buttons
  if (user.registrationStep > 1 && buttons.length < 3) {
    buttons.push({ type: "reply", reply: { id: "BACK", title: "Back" } });
  }

  await sendWhatsAppMessage(user.phoneNumber, step.prompt, buttons.length > 0 ? buttons : null);
}

async function handleRegistration(user, message) {
  try {
    if (message.toUpperCase() === "BACK" && user.registrationStep > 1) {
      user.registrationStep--;
      user.registrationData.delete(registrationSteps[user.registrationStep].field);
      await user.save();
      await sendRegistrationPrompt(user);
      return;
    }

    const step = registrationSteps[user.registrationStep - 1];
    let isValid = true;
    let parsedValue = message;

    // Input validation
    switch (step.field) {
      case "dateOfBirth":
        const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
        if (!dateRegex.test(message)) {
          isValid = false;
        } else {
          const [day, month, year] = message.split('/');
          parsedValue = new Date(year, month - 1, day);
          if (isNaN(parsedValue.getTime()) || parsedValue >= new Date()) {
            isValid = false;
          }
        }
        break;
      case "gender":
      case "medicalAidProvider":
        if (step.options && !step.options.includes(message)) {
          isValid = false;
        }
        break;
      case "dependentNumber":
        if (message.toUpperCase() === "N/A") {
          parsedValue = null;
        }
        break;
    }

    if (!isValid) {
      await sendWhatsAppMessage(user.phoneNumber, "Invalid input. Please try again.");
      await sendRegistrationPrompt(user);
      return;
    }

    user.registrationData.set(step.field, parsedValue);

    if (user.registrationStep < registrationSteps.length) {
      user.registrationStep++;
      await user.save();
      await sendRegistrationPrompt(user);
    } else {
      // Registration complete
      for (const [field, value] of user.registrationData) {
        user[field] = value;
      }
      user.isRegistrationComplete = true;
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, `Thank you for registering, ${user.firstName}! Your registration is now complete. You can now use our WhatsApp medication delivery service.`);
    }
  } catch (error) {
    console.error("Error in handleRegistration:", error);
    await sendWhatsAppMessage(
      user.phoneNumber,
      "We encountered an error processing your registration. Please try again or contact support if the issue persists."
    );
  }
}

async function sendWelcomeMessage(user) {
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Welcome to Telepharma Botswana! To start using our WhatsApp medication delivery service, you need to complete a quick registration process. This will help us serve you better. Let's begin!"
  );
  await sendRegistrationPrompt(user);
}

app.post("/webhook", async (req, res) => {
  const { entry } = req.body;

  if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
    const message = entry[0].changes[0].value.messages[0];
    const from = message.from;
    const messageBody = message.text?.body || message.interactive?.button_reply?.title || "";

    try {
      let user = await User.findOne({ phoneNumber: from });

      if (!user) {
        user = new User({ 
          phoneNumber: from,
          registrationStep: 1,
          registrationData: new Map()
        });
        await user.save();
        await sendWelcomeMessage(user);
      } else {
        user.lastInteraction = new Date();
        await user.save();
        
        if (!user.isRegistrationComplete) {
          await handleRegistration(user, messageBody);
        } else {
          await sendWhatsAppMessage(user.phoneNumber, "Your registration is already complete. How can we assist you with our medication delivery service today?");
        }
      }
    } catch (error) {
      console.error("Error processing webhook:", error);
    }
  }

  res.sendStatus(200);
});

// Webhook verification endpoint
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log("Webhook verified");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
