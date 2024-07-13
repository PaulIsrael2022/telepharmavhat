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
const WHATSAPP_API_URL = "https://graph.facebook.com/v12.0";
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
    console.error("Error sending WhatsApp message:", error);
  }
}

// Webhook endpoint for WhatsApp
app.post("/webhook", async (req, res) => {
  const { entry } = req.body;

  if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
    const message = entry[0].changes[0].value.messages[0];
    const from = message.from;
    const messageBody = message.text?.body || "";

    try {
      let user = await User.findOne({ phoneNumber: from });

      if (!user) {
        user = new User({ phoneNumber: from, registrationStep: 1 });
        await user.save();
        await sendWelcomeMessage(user);
      } else {
        user.lastInteraction = new Date();
        await user.save();

        if (user.registrationStep < 8) {
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

async function sendWelcomeMessage(user) {
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Welcome to Telepharma Botswana! Let's start the registration process.\n\nStep 1: Please provide your first name."
  );
}

async function handleRegistration(user, message) {
  try {
    switch (user.registrationStep) {
      case 1:
        user.firstName = message;
        user.registrationStep = 2;
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Step 2: Please provide your surname."
        );
        break;
      case 2:
        user.surname = message;
        user.registrationStep = 3;
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Step 3: Please provide your date of birth in the format DD/MM/YYYY."
        );
        break;
      case 3:
        const [day, month, year] = message.split('/');
        user.dateOfBirth = new Date(year, month - 1, day); // month is 0-indexed in JS Date
        user.registrationStep = 4;
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Step 4: Please select your medical aid provider:",
          [
            { type: "reply", reply: { id: "BOMAID", title: "BOMAID" } },
            { type: "reply", reply: { id: "PULA", title: "PULA" } },
            { type: "reply", reply: { id: "BPOMAS", title: "BPOMAS" } },
            { type: "reply", reply: { id: "BOTSOGO", title: "BOTSOGO" } },
          ]
        );
        break;
      case 4:
        user.medicalAidProvider = message;
        user.registrationStep = 5;
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Step 5: Please provide your medical aid number."
        );
        break;
      case 5:
        user.medicalAidNumber = message;
        user.registrationStep = 6;
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Step 6: Please specify your scheme (if applicable). If not applicable, type 'N/A'."
        );
        break;
      case 6:
        user.scheme = message === 'N/A' ? null : message;
        user.registrationStep = 7;
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Step 7: If you have a dependent number, please provide it. If not applicable, type 'N/A'."
        );
        break;
      case 7:
        user.dependentNumber = message === 'N/A' ? null : message;
        user.registrationStep = 8;
        await user.save();
        await sendWhatsAppMessage(
          user.phoneNumber,
          `Thank you for completing your registration, ${user.firstName}! You can now use our services. What would you like to do?`,
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
        break;
      default:
        console.error(`Unexpected registration step: ${user.registrationStep}`);
        await sendWhatsAppMessage(
          user.phoneNumber,
          "We encountered an error in the registration process. Please contact support for assistance."
        );
    }
  } catch (error) {
    console.error("Error in handleRegistration:", error);
    await sendWhatsAppMessage(
      user.phoneNumber,
      "We encountered an error processing your registration. Please try again or contact support if the issue persists."
    );
  }
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
      // Here you would typically notify a staff member or add the user to a queue
      break;
    case "CHECK_ORDER_STATUS":
      await sendOrderStatus(user);
      break;
    default:
      if (message.startsWith("http")) {
        // Assume this is a prescription photo URL
        await createPrescription(user, { prescriptionPhotoUrl: message });
        await sendWhatsAppMessage(
          user.phoneNumber,
          "Thank you for providing your prescription. We'll process your request, and a pharmacist will review it. Your medication will be delivered soon."
        );
      } else {
        // Assume this is prescription text or OTC medicine name
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
