import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { calculateDistanceMeters } from "./db/index.js";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || "";
const aiClient = new GoogleGenAI({ apiKey });

export async function generatePatientChatResponse(userMessage, previousHistory = [], patientProfile = {}, caregiverNameOverride = null) {
  const patientName = patientProfile.name || "Arthur";
  const caregiverName = caregiverNameOverride || patientProfile.caregiverName || "your caregiver";
  const address = patientProfile.currentLocation?.address || "your home";
  const age = patientProfile.age || 76;
  const emergencyPhone = patientProfile.emergencyPhone || "911";

  // Real-time Spatial Context
  const curLat = patientProfile.currentLocation?.lat;
  const curLng = patientProfile.currentLocation?.lng;
  const homeLat = patientProfile.safeZone?.center?.lat;
  const homeLng = patientProfile.safeZone?.center?.lng;
  const safeRadius = patientProfile.safeZone?.radiusMeters || 400;
  const isMissing = patientProfile.isMissing || false;

  let distMeters = 0;
  if (curLat && curLng && homeLat && homeLng) {
    distMeters = Math.round(calculateDistanceMeters(curLat, curLng, homeLat, homeLng));
  }

  const isFarFromHome = isMissing || distMeters > safeRadius;
  const locationStatus = isFarFromHome
    ? `OUTSIDE SAFE ZONE (${distMeters} meters away from home)`
    : `INSIDE SAFE ZONE (${distMeters} meters from home)`;

  const defaultNotUnderstood = `I'm sorry, I didn't quite understand that, ${patientName}. Could you please say that again, or ask me about your home, caregiver, or how you're feeling?`;

  // 1. Live Gemini 3.7 Flash LLM Integration (if GEMINI_API_KEY is configured)
  if (apiKey) {
    try {
      const systemInstruction = `
You are "Sunny", an extraordinarily gentle, warm, and attentive AI companion specifically caring for ${patientName} (age ${age}), who has dementia.

Core Knowledge Base:
- Patient Name: ${patientName}
- Caregiver Name: ${caregiverName}
- Home Address: ${address}
- Emergency Phone: ${emergencyPhone}
- Location Status: ${locationStatus}

CRITICAL ADVICE GUIDELINES:
1. Way Back Home Instructions: If ${patientName} asks "how do I go home?", "how to get home?", "which way is home?", "guide me home", or asks for directions back home:
   - First, gently remind them: "You can tap the blue 'Navigate Home' button on your screen — it will show you the walking way home, step by step."
   - Then add: "If you'd feel safer with help, you can also tap 'Call Help' to reach ${caregiverName} right away."
   - Keep this warm and simple, not alarming.
2. Spatial Answers: If asked "am I lost?" or "where am I?":
   - If FAR FROM HOME: Gentle alert: "You are currently ${distMeters} meters from home. Don't worry, ${caregiverName} has been notified! You can tap 'Navigate Home' for walking directions, or 'Call Help' to reach ${caregiverName}."
   - If AT HOME: Reassure: "You are safe inside your home area, only ${distMeters} meters from home."
3. Identity Questions: If asked "who am I?" or "what is my name?", tell them: "You are ${patientName}! You are ${age} years old and your caregiver is ${caregiverName}."
4. Unrecognized/Gibberish: If the message is meaningless noise or gibberish, reply ONLY: "${defaultNotUnderstood}"
5. Tone: 1-3 short, comforting sentences.
`;

      const contextPrompt = previousHistory.slice(-6).map(h => 
        `${h.sender === 'user' ? patientName : 'Sunny'}: ${h.text}`
      ).join('\n');

      const fullPrompt = `${contextPrompt}\n${patientName}: ${userMessage}\nSunny:`;

      const response = await aiClient.interactions.create({
        model: "gemini-3.1-flash-lite",
        input: fullPrompt,
        system_instruction: systemInstruction,
        generation_config: {
          max_output_tokens: 150,
          temperature: 0.5
        }
      });

      const replyText = response.output_text;
      if (replyText) {
        return {
          text: replyText.trim(),
          interactionId: response.id
        };
      }
    } catch (err) {
      console.error("Gemini API Call Error:", err.message);
    }
  }

  // 2. Strict Intent & Natural Language Engine (Offline / Fallback Mode)
  const text = userMessage.toLowerCase().trim();

  // Pattern 0: Way Back Home / Directions to Home ("how do i go home", "how to get home", "which way is home", "guide me home", "way back home", "how to go back home")
  if (/\b(how to (go|get) home|how do i (go|get) home|which way is home|guide me home|way back home|how to go back|directions to home|lead me home)\b/.test(text)) {
    return {
      text: `You can tap the blue "Navigate Home" button on your screen, ${patientName} — it will show you the walking way home, step by step. If you'd feel safer with help, you can also tap "Call Help" to reach ${caregiverName} right away.`,
      fallback: true
    };
  }

  // Pattern A: Spatial / Lost / Location Questions ("am i lost", "where am i", "how far", "distance", "far from home")
  if (/\b(lost|am i lost|where am i|how far|far from home|distance|where i am|am i far)\b/.test(text)) {
    if (isFarFromHome) {
      return {
        text: `You are currently ${distMeters} meters away from home. Don't worry, ${patientName} — ${caregiverName} has been notified. You can tap "Navigate Home" on your screen for walking directions, or "Call Help" to reach ${caregiverName} directly.`,
        fallback: true
      };
    } else {
      return {
        text: `You are completely safe right now, ${patientName}! You are inside your home safe area, only ${distMeters} meters from home.`,
        fallback: true
      };
    }
  }

  // Pattern B: Patient Identity ("who am i", "my name", "who i am", "what is my name")
  if (/\b(who am i|my name|do you know me|who i am|what is my name|what's my name)\b/.test(text)) {
    return {
      text: `You are ${patientName}! You are ${age} years old, and your caregiver ${caregiverName} takes wonderful care of you.`,
      fallback: true
    };
  }

  // Pattern C: Home Address ("where is my home", "where do i live", "my address")
  if (/\b(where is my home|where do i live|my address|what is my address|what's my address)\b/.test(text)) {
    return {
      text: `Your home is located at ${address}. You are ${distMeters} meters from home right now.`,
      fallback: true
    };
  }

  // Pattern D: Caregiver Info ("who is my caregiver", "who takes care of me", "sarah")
  if (/\b(who is my caregiver|who takes care of me|caregiver|who is watching me)\b/.test(text) || text.includes(caregiverName.toLowerCase())) {
    return {
      text: `Your primary caregiver is ${caregiverName}. She checks in on you regularly and leaves notes for you on your screen!`,
      fallback: true
    };
  }

  // Pattern E: Emergency / Contact
  if (/\b(phone|emergency|call|contact|number)\b/.test(text)) {
    return {
      text: `Your emergency contact phone for ${caregiverName} is ${emergencyPhone}. If you feel unwell, tap the red button on your screen anytime.`,
      fallback: true
    };
  }

  // Pattern F: Time & Date
  if (/\b(time|day|date|clock)\b/.test(text)) {
    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dayStr = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    return {
      text: `Today is ${dayStr}, and it is currently ${nowStr}. You're having a calm day!`,
      fallback: true
    };
  }

  // Pattern G: Food & Hunger
  if (/\b(hungry|food|eat|lunch|dinner|breakfast|snack)\b/.test(text)) {
    return {
      text: `It sounds like a nice time for a snack, ${patientName}! ${caregiverName} left fresh food for you in the kitchen.`,
      fallback: true
    };
  }

  // Pattern H: AI Companion Identity
  if (/\b(who are you|your name|what are you|who's sunny)\b/.test(text)) {
    return {
      text: `I am Sunny, your friendly companion! I'm right here on your phone to chat with you and help you remember anything you need.`,
      fallback: true
    };
  }

  // Pattern I: Valid Greetings & Casual Small Talk
  if (/\b(hi|hello|hey|good morning|good afternoon|good evening|greetings)\b/.test(text)) {
    return {
      text: `Hello ${patientName}! It is so nice to talk with you. How are you feeling right now?`,
      fallback: true
    };
  }

  if (/\b(how are you|how do you do|doing well|fine|good|happy|sad|tired|okay|thanks|thank you)\b/.test(text)) {
    return {
      text: `Thank you for sharing that with me, ${patientName}. I'm always right here with you, and ${caregiverName} is keeping you safe!`,
      fallback: true
    };
  }

  // STRICT FALLBACK FOR ALL OTHER UNRECOGNIZED INPUT / GIBBERISH / TYPOS / NOISE:
  return {
    text: defaultNotUnderstood,
    fallback: true
  };
}
