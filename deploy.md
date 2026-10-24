# Install live captions

## Before you start

This puts live captions on the church Google account. It takes about 15 minutes. You need a card on Google Cloud billing. Later pages walk you through a Soniox account, which turns speech into captions.

Click **Start**. The next page has one command to copy into the terminal.

## Run the install

Click the **copy** button on the box below (it pastes into the terminal at the bottom of the screen), then press **Enter**.

```bash
./deploy.sh
```

Google Cloud now sets itself up, which takes a few minutes. You don't need to wait: click **Next** and get your Soniox key while it works.

To add another church on this same Google account, go back to the captions website and choose **Set up another church**. If this account already has several, the terminal asks which one you mean.

## Get your Soniox key while it works

Soniox turns speech into captions and translations.

1. Open [console.soniox.com](https://console.soniox.com) and sign up, or sign in.
2. Add some credit under Billing. See [Soniox pricing](https://soniox.com/pricing). We recommend also turning on **Enable autopay** there, which tops up from your card when the credit runs low, so captions never stop mid-service.
3. Click **API keys**, then **Create API key**, and copy it.
4. Come back to the terminal, paste the key and press **Enter**. Nothing appears while you paste. That's normal.

If the terminal has closed or disconnected in the meantime, click **Install on Google Cloud** on the captions website again. It carries on where it left off.

## Finish

When the terminal says **Done!**, open the link it prints. It takes you back to the captions website, now set up as your sound desk, with the QR code and links to share.

If something goes wrong, the terminal explains what to do. Running the install again is always safe.
