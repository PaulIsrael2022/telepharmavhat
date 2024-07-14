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
  isRegistrationComplete: { type: Boolean, default: false },
  lastInteraction: { type: Date, default: Date.now },
  addresses: {
    home: { type: String, default: null },
    work: { type: String, default: null }
  },
  preferences: {
    notificationPreference: {
      type: String,
      enum: ["SMS", "WhatsApp", "Email"],
      default: "WhatsApp",
    },
    language: { type: String, default: "English" },
  },
  conversationState: {
    currentFlow: { type: String, default: null },
    currentStep: { type: String, default: null },
    data: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() }
  }
});

const User = mongoose.model("User", userSchema);

// Order Schema
const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderNumber: { type: String, unique: true, required: true },
  orderType: { 
    type: String, 
    enum: ['PRESCRIPTION_REFILL', 'NEW_PRESCRIPTION', 'OVER_THE_COUNTER'], 
    required: true 
  },
  medications: [{
    name: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    instructions: { type: String }
  }],
  prescriptionImage: { type: String },  // URL to stored image
  forDependant: { type: Boolean, default: false },
  dependantDetails: {
    firstName: { type: String },
    lastName: { type: String },
    dateOfBirth: { type: Date }
  },
  deliveryMethod: { 
    type: String, 
    enum: ['DELIVERY', 'PICKUP'], 
    required: true 
  },
  deliveryAddress: {
    type: { type: String, enum: ['HOME', 'WORK'] },
    address: { type: String }
  },
  status: { 
    type: String, 
    enum: ['PENDING', 'PROCESSING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'], 
    default: 'PENDING' 
  }
}, { timestamps: true });

const Order = mongoose.model("Order", orderSchema);

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
    // Send a generic error message to the user
    await sendWhatsAppMessage(to, "Sorry, we encountered an error. Please try again or contact support if the issue persists.");
  }
}

// Registration steps
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
    prompt: "Step 5: Please select your medical aid provider. Type a number:\n1. BOMAID\n2. PULA\n3. BPOMAS\n4. BOTSOGO",
    field: "medicalAidProvider",
    options: ["BOMAID", "PULA", "BPOMAS", "BOTSOGO"]
  },
  { prompt: "Step 6: Please provide your medical aid number.", field: "medicalAidNumber" },
  { prompt: "Step 7: Please specify your scheme (if applicable).", field: "scheme" },
  { prompt: "Step 8: If you have a dependent number, please provide it. Otherwise, type \"N/A\".", field: "dependentNumber" },
];

async function sendRegistrationPrompt(user) {
  const step = registrationSteps[user.conversationState.currentStep];
  let message = step.prompt;

  if (user.conversationState.currentStep > 0) {
    message += "\n\n_Enter \"00\" to go back to the previous step._";
  }

  if (step.field === "gender") {
    const buttons = [
      { type: "reply", reply: { id: "MALE", title: "MALE" } },
      { type: "reply", reply: { id: "FEMALE", title: "FEMALE" } },
    ];
    await sendWhatsAppMessage(user.phoneNumber, message, buttons);
  } else {
    await sendWhatsAppMessage(user.phoneNumber, message);
  }
}

async function handleRegistration(user, message) {
  try {
    if (message === "00" && user.conversationState.currentStep > 0) {
      user.conversationState.currentStep--;
      user.conversationState.data.delete(registrationSteps[user.conversationState.currentStep].field);
      await user.save();
      await sendRegistrationPrompt(user);
      return;
    }

    const step = registrationSteps[user.conversationState.currentStep];
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
        if (message !== "MALE" && message !== "FEMALE") {
          isValid = false;
        }
        break;
      case "medicalAidProvider":
        const index = parseInt(message) - 1;
        if (index >= 0 && index < step.options.length) {
          parsedValue = step.options[index];
        } else {
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

    user.conversationState.data.set(step.field, parsedValue);

    if (user.conversationState.currentStep < registrationSteps.length - 1) {
      user.conversationState.currentStep++;
      await user.save();
      await sendRegistrationPrompt(user);
    } else {
      // Registration complete
      for (const [field, value] of user.conversationState.data) {
        user[field] = value;
      }
      user.isRegistrationComplete = true;
      user.conversationState = {
        currentFlow: 'MAIN_MENU',
        currentStep: null,
        data: new Map()
      };
      await user.save();
      await sendCompletionMessage(user);
    }
  } catch (error) {
    console.error("Error in handleRegistration:", error);
    await sendWhatsAppMessage(
      user.phoneNumber,
      "We encountered an error processing your registration. Please try again or contact support if the issue persists."
    );
  }
}

async function sendCompletionMessage(user) {
  const message = `Thank you for registering, ${user.firstName}! Your registration is now complete. You can now use our WhatsApp medication delivery service.`;
  const buttons = [
    { type: "reply", reply: { id: "PLACE_ORDER", title: "Place Order" } },
    { type: "reply", reply: { id: "MAIN_MENU", title: "Main Menu" } },
  ];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
}

async function sendWelcomeMessage(user) {
  await sendWhatsAppMessage(
    user.phoneNumber,
    "Welcome to Telepharma Botswana! To start using our WhatsApp medication delivery service, you need to complete a quick registration process. This will help us serve you better. Let's begin!"
  );
  await sendRegistrationPrompt(user);
}

async function sendMainMenu(user) {
  const message = "Main Menu:\n0. Place an Order\n1. View Order Status\n2. Medication Delivery\n3. Pharmacy Consultation\n4. Doctor Consultation\n5. General Enquiry";
  const buttons = [
    { type: "reply", reply: { id: "PLACE_ORDER", title: "Place Order" } },
    { type: "reply", reply: { id: "VIEW_ORDER_STATUS", title: "View Order Status" } },
    { type: "reply", reply: { id: "MEDICATION_DELIVERY", title: "Medication Delivery" } },
  ];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
}

async function handleMainMenu(user, message) {
  switch (message) {
    case "0":
    case "PLACE_ORDER":
      user.conversationState = {
        currentFlow: 'PLACE_ORDER',
        currentStep: 'MEDICATION_TYPE',
        data: new Map()
      };
      await user.save();
      await sendMedicationTypeOptions(user);
      break;
    case "1":
    case "VIEW_ORDER_STATUS":
      user.conversationState = {
        currentFlow: 'VIEW_ORDER_STATUS',
        currentStep: 'ENTER_ORDER_NUMBER',
        data: new Map()
      };
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, "Please enter your order number.");
      break;
    case "2":
    case "MEDICATION_DELIVERY":
      user.conversationState = {
        currentFlow: 'MEDICATION_DELIVERY',
        currentStep: 'ENTER_ADDRESS',
        data: new Map()
      };
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, "Please enter your delivery address.");
      break;
    case "3":
      user.conversationState = {
        currentFlow: 'PHARMACY_CONSULTATION',
        currentStep: 'ENTER_ISSUE',
        data: new Map()
      };
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, "Please describe your issue or question for the pharmacy.");
      break;
    case "4":
      user.conversationState = {
        currentFlow: 'DOCTOR_CONSULTATION',
        currentStep: 'ENTER_ISSUE',
        data: new Map()
      };
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, "Please describe your issue or question for the doctor.");
      break;
    case "5":
      user.conversationState = {
        currentFlow: 'GENERAL_ENQUIRY',
        currentStep: 'ENTER_ENQUIRY',
        data: new Map()
      };
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, "Please enter your general enquiry.");
      break;
    default:
      await sendWhatsAppMessage(user.phoneNumber, "Invalid option. Please try again.");
      await sendMainMenu(user);
  }
}

async function sendMedicationTypeOptions(user) {
  const message = "Medication Details";
  const buttons = [
    { type: "reply", reply: { id: "PRESCRIPTION_MEDICINE", title: "Prescription Medicine" } },
    { type: "reply", reply: { id: "OVER_THE_COUNTER", title: "Over-the-Counter" } },
  ];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
}

async function handlePlaceOrder(user, message) {
  switch (user.conversationState.currentStep) {
    case 'MEDICATION_TYPE':
      if (message === 'PRESCRIPTION_MEDICINE') {
        user.conversationState.currentStep = 'PRESCRIPTION_OPTIONS';
        await user.save();
        await sendPrescriptionOptions(user);
      } else if (message === 'OVER_THE_COUNTER') {
        user.conversationState.currentStep = 'OTC_MEDICATION_LIST';
        await user.save();
        await sendWhatsAppMessage(user.phoneNumber, "Please enter a list of medications you would like to order.");
      }
      break;
    case 'PRESCRIPTION_OPTIONS':
      await handlePrescriptionOptions(user, message);
      break;
    case 'OTC_MEDICATION_LIST':
      user.conversationState.data.set('medications', message);
      user.conversationState.currentStep = 'DELIVERY_METHOD';
      await user.save();
      await sendDeliveryOptions(user);
      break;
    case 'DELIVERY_METHOD':
      await handleDeliveryMethod(user, message);
      break;
    case 'ENTER_WORK_ADDRESS':
      user.conversationState.data.set('workAddress', message);
      await finishOrder(user);
      break;
    case 'ENTER_HOME_ADDRESS':
      user.conversationState.data.set('homeAddress', message);
      await finishOrder(user);
      break;
    default:
      await sendWhatsAppMessage(user.phoneNumber, "Invalid step in order process. Returning to main menu.");
      user.conversationState = {
        currentFlow: 'MAIN_MENU',
        currentStep: null,
        data: new Map()
      };
      await user.save();
      await sendMainMenu(user);
  }
}

async function sendPrescriptionOptions(user) {
  const message = "Prescription Options:";
  const buttons = [
    { type: "reply", reply: { id: "PRESCRIPTION_REFILL", title: "Prescription Refill" } },
    { type: "reply", reply: { id: "NEW_PRESCRIPTION", title: "New Prescription" } },
    { type: "reply", reply: { id: "MAIN_MENU", title: "Main Menu" } },
  ];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
}

async function handlePrescriptionOptions(user, message) {
  switch (message) {
    case 'PRESCRIPTION_REFILL':
      user.conversationState.currentStep = 'SELECT_REFILL';
      user.conversationState.data.set('orderType', 'PRESCRIPTION_REFILL');
      await user.save();
      await sendRefillOptions(user);
      break;
    case 'NEW_PRESCRIPTION':
      user.conversationState.currentStep = 'NEW_PRESCRIPTION_FOR';
      user.conversationState.data.set('orderType', 'NEW_PRESCRIPTION');
      await user.save();
      await sendNewPrescriptionOptions(user);
      break;
    case 'MAIN_MENU':
      user.conversationState = {
        currentFlow: 'MAIN_MENU',
        currentStep: null,
        data: new Map()
      };
      await user.save();
      await sendMainMenu(user);
      break;
    default:
      await sendWhatsAppMessage(user.phoneNumber, "Invalid option. Please try again.");
      await sendPrescriptionOptions(user);
  }
}

async function sendRefillOptions(user) {
  // In a real-world scenario, you would fetch the user's last three orders from the database
  // For this example, we'll use placeholder data
  const message = "Select Your Refill:\n1. Medication A\n2. Medication B\n3. Medication C";
  await sendWhatsAppMessage(user.phoneNumber, message);
}

async function sendNewPrescriptionOptions(user) {
  const message = "Who is the prescription for?";
  const buttons = [
    { type: "reply", reply: { id: "PRINCIPAL_MEMBER", title: "Principal Member" } },
    { type: "reply", reply: { id: "DEPENDANT", title: "Dependant" } },
  ];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
}

async function sendDeliveryOptions(user) {
  const message = "Would you like the medication to be delivered, or will you be picking it up?";
  const buttons = [
    { type: "reply", reply: { id: "DELIVERY", title: "Delivery" } },
    { type: "reply", reply: { id: "PICKUP", title: "Pickup" } },
    { type: "reply", reply: { id: "MAIN_MENU", title: "Main Menu" } },
  ];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
}

async function handleDeliveryMethod(user, message) {
  switch (message) {
    case 'DELIVERY':
      user.conversationState.currentStep = 'DELIVERY_ADDRESS_TYPE';
      user.conversationState.data.set('deliveryMethod', 'DELIVERY');
      await user.save();
      await sendDeliveryAddressOptions(user);
      break;
    case 'PICKUP':
      user.conversationState.data.set('deliveryMethod', 'PICKUP');
      await finishOrder(user);
      break;
    case 'MAIN_MENU':
      user.conversationState = {
        currentFlow: 'MAIN_MENU',
        currentStep: null,
        data: new Map()
      };
      await user.save();
      await sendMainMenu(user);
      break;
    default:
      await sendWhatsAppMessage(user.phoneNumber, "Invalid option. Please try again.");
      await sendDeliveryOptions(user);
  }
}

async function sendDeliveryAddressOptions(user) {
  const message = "Where do you want your medication to be delivered?";
  const buttons = [
    { type: "reply", reply: { id: "WORK", title: "Work" } },
    { type: "reply", reply: { id: "HOME", title: "Home" } },
  ];
  await sendWhatsAppMessage(user.phoneNumber, message, buttons);
}

async function handleDeliveryAddressType(user, message) {
  switch (message) {
    case 'WORK':
      user.conversationState.currentStep = 'ENTER_WORK_ADDRESS';
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, "Please enter your work name and physical address.");
      break;
    case 'HOME':
      user.conversationState.currentStep = 'ENTER_HOME_ADDRESS';
      await user.save();
      await sendWhatsAppMessage(user.phoneNumber, "Please enter your home address.");
      break;
    default:
      await sendWhatsAppMessage(user.phoneNumber, "Invalid option. Please try again.");
      await sendDeliveryAddressOptions(user);
  }
}

async function finishOrder(user) {
  // Create a new order in the database
  const order = new Order({
    user: user._id,
    orderNumber: generateOrderNumber(),
    orderType: user.conversationState.data.get('orderType'),
    medications: [{ name: user.conversationState.data.get('medications') }],
    deliveryMethod: user.conversationState.data.get('deliveryMethod'),
    deliveryAddress: {
      type: user.conversationState.data.get('workAddress') ? 'WORK' : 'HOME',
      address: user.conversationState.data.get('workAddress') || user.conversationState.data.get('homeAddress')
    },
    status: 'PENDING'
  });

  await order.save();

  let message;
  if (order.deliveryMethod === 'DELIVERY') {
    message = `Thank you for your order, ${user.firstName}! Your medication will be delivered soon.`;
  } else {
    message = `Thank you for your order, ${user.firstName}! Your medication will be ready for pickup soon.`;
  }

  await sendWhatsAppMessage(user.phoneNumber, message);

  // Reset conversation state
  user.conversationState = {
    currentFlow: 'MAIN_MENU',
    currentStep: null,
    data: new Map()
  };
  await user.save();

  await sendMainMenu(user);
}

function generateOrderNumber() {
  // Generate a unique order number (you might want to implement a more robust system)
  return 'ORD-' + Date.now();
}

async function handleConversation(user, message) {
  switch (user.conversationState.currentFlow) {
    case 'REGISTRATION':
      await handleRegistration(user, message);
      break;
    case 'MAIN_MENU':
      await handleMainMenu(user, message);
      break;
    case 'PLACE_ORDER':
      await handlePlaceOrder(user, message);
      break;
    case 'VIEW_ORDER_STATUS':
      await handleViewOrderStatus(user, message);
      break;
    case 'MEDICATION_DELIVERY':
      await handleMedicationDelivery(user, message);
      break;
    case 'PHARMACY_CONSULTATION':
      await handlePharmacyConsultation(user, message);
      break;
    case 'DOCTOR_CONSULTATION':
      await handleDoctorConsultation(user, message);
      break;
    case 'GENERAL_ENQUIRY':
      await handleGeneralEnquiry(user, message);
      break;
    default:
      await sendWhatsAppMessage(user.phoneNumber, "I'm sorry, I didn't understand that. Let's go back to the main menu.");
      user.conversationState = {
        currentFlow: 'MAIN_MENU',
        currentStep: null,
        data: new Map()
      };
      await user.save();
      await sendMainMenu(user);
  }
}

async function handleViewOrderStatus(user, message) {
  // In a real-world scenario, you would fetch the order status from the database
  // For this example, we'll use a placeholder response
  await sendWhatsAppMessage(user.phoneNumber, `Your order status for order number ${message} is: Processing`);
  user.conversationState = {
    currentFlow: 'MAIN_MENU',
    currentStep: null,
    data: new Map()
  };
  await user.save();
  await sendMainMenu(user);
}

async function handleMedicationDelivery(user, message) {
  await sendWhatsAppMessage(user.phoneNumber, `Your medication will be delivered to ${message}.`);
  user.conversationState = {
    currentFlow: 'MAIN_MENU',
    currentStep: null,
    data: new Map()
  };
  await user.save();
  await sendMainMenu(user);
}

async function handlePharmacyConsultation(user, message) {
  await sendWhatsAppMessage(user.phoneNumber, "Thank you. A pharmacy consultant will get back to you shortly.");
  user.conversationState = {
    currentFlow: 'MAIN_MENU',
    currentStep: null,
    data: new Map()
  };
  await user.save();
  await sendMainMenu(user);
}

async function handleDoctorConsultation(user, message) {
  await sendWhatsAppMessage(user.phoneNumber, "Thank you. A doctor will get back to you shortly.");
  user.conversationState = {
    currentFlow: 'MAIN_MENU',
    currentStep: null,
    data: new Map()
  };
  await user.save();
  await sendMainMenu(user);
}

async function handleGeneralEnquiry(user, message) {
  await sendWhatsAppMessage(user.phoneNumber, "Thank you. We will address your enquiry as soon as possible.");
  user.conversationState = {
    currentFlow: 'MAIN_MENU',
    currentStep: null,
    data: new Map()
  };
  await user.save();
  await sendMainMenu(user);
}

app.post("/webhook", async (req, res) => {
  const { entry } = req.body;

  if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
    const message = entry[0].changes[0].value.messages[0];
    const from = message.from;
    const messageBody = message.text?.body || message.interactive?.button_reply?.id || "";

    try {
      let user = await User.findOne({ phoneNumber: from });

      if (!user) {
        user = new User({ 
          phoneNumber: from,
          conversationState: {
            currentFlow: 'REGISTRATION',
            currentStep: 0,
            data: new Map()
          }
        });
        await user.save();
        await sendWelcomeMessage(user);
      } else {
        user.lastInteraction = new Date();
        await user.save();
        
        if (!user.isRegistrationComplete) {
          await handleRegistration(user, messageBody);
        } else {
          await handleConversation(user, messageBody);
        }
      }
    } catch (error) {
      console.error("Error processing webhook:", error);
      // Send a generic error message to the user
      await sendWhatsAppMessage(from, "Sorry, we encountered an error. Please try again or contact support if the issue persists.");
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
