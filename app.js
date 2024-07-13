const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Import models
const {
  User,
  Prescription,
  ServiceRequest,
  Staff,
  Inventory,
} = require("./models");

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

  if (buttons) {
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
  { prompt: "Please provide your first name.", field: "firstName", backAllowed: false },
  { prompt: "Please provide your surname.", field: "surname", backAllowed: true },
  { prompt: "Please provide your date of birth in the format DD/MM/YYYY.", field: "dateOfBirth", backAllowed: true },
  { 
    prompt: "Please select your medical aid provider:",
    field: "medicalAidProvider",
    backAllowed: true,
    options: ["BOMAID", "PULA", "BPOMAS", "BOTSOGO"]
  },
  { prompt: "Please provide your medical aid number.", field: "medicalAidNumber", backAllowed: true },
  { 
    prompt: "Please specify your scheme (if applicable).",
    field: "scheme",
    backAllowed: true,
    options: ["N/A"]
  },
  { 
    prompt: "If you have a dependent number, please provide it.",
    field: "dependentNumber",
    backAllowed: true,
    options: ["N/A"]
  },
];

async function sendRegistrationPrompt(user) {
  const step = registrationSteps[user.registrationStep - 1];
  let buttons = [];

  if (step.options) {
    buttons = step.options.map(option => ({
      type: "reply",
      reply: { id: option, title: option }
    }));
  }

  if (step.backAllowed) {
    buttons.push({ type: "reply", reply: { id: "BACK", title: "Back" } });
  }

  if (!step.options) {
    buttons.push({ type: "reply", reply: { id: "SKIP", title: "Skip" } });
  }

  await sendWhatsAppMessage(user.phoneNumber, step.prompt, buttons);
}

async function handleRegistration(user, message) {
  try {
    if (message === "BACK" && user.registrationStep > 1 && registrationSteps[user.registrationStep - 1].backAllowed) {
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
        }
        break;
      case "medicalAidProvider":
        if (!step.options.includes(message)) {
          isValid = false;
        }
        break;
      case "scheme":
      case "dependentNumber":
        if (message === "N/A") {
          parsedValue = null;
        } else if (message === "SKIP") {
          parsedValue = null;
          isValid = true;
        }
        break;
    }

    if (!isValid) {
      await sendWhatsAppMessage(user.phoneNumber, "Invalid input. Please try again.");
      await sendRegistrationPrompt(user);
      return;
    }

    if (parsedValue !== null) {
      user.registrationData.set(step.field, parsedValue);
    }

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
      await sendMainMenu(user);
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
    "Welcome to Telepharma Botswana! Let's start the registration process."
  );
  await sendRegistrationPrompt(user);
}

async function sendMainMenu(user) {
  await sendWhatsAppMessage(
    user.phoneNumber,
    `Welcome back, ${user.firstName}! How can we help you today?`,
    [
      {
        type: "reply",
        reply: { id: "MEDICATION_DELIVERY", title: "Medication Delivery" },
      },
      {
        type: "reply",
        reply: {
          id: "PHARMACY_CONSULTATION",
          title: "Pharmacy Consultation",
        },
      },
      {
        type: "reply",
        reply: { id: "DOCTOR_CONSULTATION", title: "Doctor Consultation" },
      },
      {
        type: "reply",
        reply: { id: "CHECK_ORDER_STATUS", title: "Check Order Status" },
      },
      {
        type: "reply",
        reply: { id: "GENERAL_ENQUIRY", title: "General Enquiry" },
      },
    ]
  );
}

async function handleUserInput(user, message) {
  switch (message) {
    case "MEDICATION_DELIVERY":
      await createServiceRequest(user, "Medication Delivery");
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Do you need Prescription Medicine or Over-the-Counter Medicine?",
        [
          {
            type: "reply",
            reply: { id: "PRESCRIPTION", title: "Prescription Medicine" },
          },
          {
            type: "reply",
            reply: { id: "OTC", title: "Over-the-Counter Medicine" },
          },
        ]
      );
      break;
    case "PRESCRIPTION":
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please upload a photo of your prescription or type it out."
      );
      break;
    case "OTC":
      await sendWhatsAppMessage(
        user.phoneNumber,
        "Please provide the name of the over-the-counter medicine you need."
      );
      break;
    case "PHARMACY_CONSULTATION":
    case "DOCTOR_CONSULTATION":
    case "GENERAL_ENQUIRY":
      await createServiceRequest(user, message);
      await sendWhatsAppMessage(
        user.phoneNumber,
        "A healthcare professional will be with you shortly. Please wait for their response."
      );
      break;
    case "CHECK_ORDER_STATUS":
      await sendOrderStatus(user);
      break;
    default:
      if (message.startsWith("http")) {
        await createPrescription(user, { prescriptionPhotoUrl: message });
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Thank you for providing your prescription. We'll process your request, and a pharmacist will review it. Your medication will be delivered soon."
        );
      } else {
        await createPrescription(user, { prescriptionText: message });
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Thank you for your request. A pharmacist will review it and get back to you soon."
        );
      }
      await sendMainMenu(user);
  }
}

async function createServiceRequest(user, serviceType) {
  const serviceRequest = new ServiceRequest({
    userId: user._id,
    serviceType: serviceType,
    status: "Pending",
  });
  await serviceRequest.save();
}

async function createPrescription(user, prescriptionData) {
  const prescription = new Prescription({
    userId: user._id,
    ...prescriptionData,
    status: "Pending",
  });
  await prescription.save();
}

async function sendOrderStatus(user) {
  const recentPrescriptions = await Prescription.find({ userId: user._id })
    .sort({ createdAt: -1 })
    .limit(5);

  if (recentPrescriptions.length === 0) {
    await sendWhatsAppMessage(
      user.phoneNumber,
      "You don't have any recent orders. Would you like to place a new order?",
      [
        {
          type: "reply",
          reply: { id: "MEDICATION_DELIVERY", title: "Place New Order" },
        },
        {
          type: "reply",
          reply: { id: "MAIN_MENU", title: "Back to Main Menu" },
        },
      ]
    );
  } else {
    let statusMessage = "Here are your recent orders:\n\n";
    recentPrescriptions.forEach((prescription, index) => {
      statusMessage += `${index + 1}. Order ID: ${
        prescription._id
      }\n   Status: ${
        prescription.status
      }\n   Created: ${prescription.createdAt.toDateString()}\n\n`;
    });
    statusMessage +=
      "Would you like to place a new order or go back to the main menu?";

    await sendWhatsAppMessage(user.phoneNumber, statusMessage, [
      {
        type: "reply",
        reply: { id: "MEDICATION_DELIVERY", title: "Place New Order" },
      },
      {
        type: "reply",
        reply: { id: "MAIN_MENU", title: "Back to Main Menu" },
      },
    ]);
  }
}

app.post("/webhook", async (req, res) => {
  const { entry } = req.body;

  if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
    const message = entry[0].changes[0].value.messages[0];
    const from = message.from;
    const messageBody = message.text?.body || "";

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
          await handleUserInput(user, messageBody);
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
