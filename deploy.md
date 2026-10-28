# Install live captions

## Before you start

This puts live captions on your Google account. It takes about 15 minutes. Google Cloud hosts the server. Normal use stays in the free tier, but Google still asks for a card, and the install emails you if this venue passes £5 a month. Soniox turns the speech into captions. You choose how much credit to add, and it is only used while someone is being captioned. That is the part that costs money, and it costs less than a captioning service you subscribe to.

To update a venue later, sign in with the Google account that set it up, or with another account that can manage that same Google Cloud project. An account without that access will not see the venue.

Click **Start**. The next page has one command to copy into the terminal.

## Run the install

Click the **copy** button on the box below (it pastes into the terminal at the bottom of the screen), then press **Enter**.

```bash
./setup.sh
```

The terminal lists any venues already on this account. Pick one to use it again, or the last line to set up another. A new one asks what to call it. Press Enter to keep the name Live captions, then which billing account to use.

Google Cloud then sets itself up, which takes a few minutes. You don't need to wait: click **Next** and get your Soniox key while it works.

## Get your Soniox key while it works

Soniox turns speech into captions and translations. This is the part that costs money. You choose how much credit to add, and it is only used while someone is being captioned.

1. Open [console.soniox.com](https://console.soniox.com) and sign up, or sign in.
2. Add a small amount of credit under Billing. You choose how much. Quiet audio isn't sent, and a language runs only while someone is reading it. That costs less than a captioning service you subscribe to. See [Soniox pricing](https://soniox.com/pricing). Autopay is optional. It tops up by an amount you set, so captions don't stop in the middle when the credit runs out.
3. Click **API keys**, then **Create API key**, and copy it.
4. Come back to the terminal, paste the key and press **Enter**. Nothing appears while you paste. That's normal.

If the terminal has closed or disconnected in the meantime, click **Set up live captions** on the captions website again. It carries on where it left off.

## Finish

When the terminal says **Done!**, open the link it prints. It takes you back to the captions website, now set up as your sound desk, with the QR code and links to share.

If something goes wrong, the terminal explains what to do. Running the install again is always safe.
