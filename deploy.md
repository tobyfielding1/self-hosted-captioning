# Install live captions

## Start the install

Click the **copy** button on the box below (it pastes into the terminal at the bottom of the screen), then press **Enter**.

```bash
git pull -q --ff-only; ./deploy.sh
```

Google Cloud now sets itself up, which takes a few minutes. You don't need to wait: click the button at the bottom of this panel and get your Soniox key while it works.

## Get your Soniox key while it works

Soniox turns speech into captions and translations.

1. Open [console.soniox.com](https://console.soniox.com) and sign up, or sign in.
2. Add some credit under Billing. See [Soniox pricing](https://soniox.com/pricing).
3. Click **API keys**, then **Create API key**, and copy it.
4. Come back to the terminal, paste the key and press **Enter**. Nothing appears while you paste. That's normal.

If the terminal has closed or disconnected in the meantime, click **Install on Google Cloud** on the Setup page again. It carries on where it left off.

## Finish

When the terminal says **Done!**, open the link it prints. It takes you back to the Setup page with everything filled in.

If something goes wrong, the terminal explains what to do. Running the install again is always safe.
