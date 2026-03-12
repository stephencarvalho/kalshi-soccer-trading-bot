const twilio = require('twilio');

class Notifier {
  constructor(config, logger) {
    this.logger = logger;
    this.enabled = Boolean(
      config.twilioAccountSid &&
        config.twilioAuthToken &&
        config.twilioFromWhatsApp &&
        config.twilioToWhatsApp,
    );

    if (this.enabled) {
      this.client = twilio(config.twilioAccountSid, config.twilioAuthToken);
      this.from = config.twilioFromWhatsApp;
      this.to = config.twilioToWhatsApp;
    }
  }

  async send(message) {
    this.logger.info({ message }, 'Notification');
    if (!this.enabled) return;

    try {
      await this.client.messages.create({
        from: this.from,
        to: this.to,
        body: message,
      });
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to send WhatsApp message');
    }
  }
}

module.exports = { Notifier };
