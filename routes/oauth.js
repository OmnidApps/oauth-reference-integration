// This module demonstrates how your Checkr integration can authorize itself
// with OAuth. OAuth authorization will enable your integration to make
// requests against Checkr on your user's behalf. It will provide a working
// code example for the following Checkr docs:
// - [How to retrieve an OAuth access
//   token from Checkr](https://docs.checkr.com/partners/#section/Getting-Started/Connect-your-customers-to-Checkr)
// - [How to validate and respond to Checkr
//   webhooks](https://docs.checkr.com/partners/#section/Webhooks/Responding-to-and-securing-webhooks)
// - [How to receive the account.credentialed
//   webhook](https://docs.checkr.com/partners/#section/Getting-Started/Customer-account-credentialing)
// - [How to deauthorize your OAuth
//   token](https://docs.checkr.com/partners/#section/Getting-Started/Display-customers'-connected-state-and-deauthorization)

import express from 'express'
import database from '../db.js'
import fetch from 'node-fetch'
import {parseJSON, findAccountWithMatchingToken} from '../helpers/index.js'
import {encrypt, decrypt} from '../encryption.js'
const {createHmac, timingSafeEqual} = await import('node:crypto')

const oauthRouter = express.Router()

// OAuth Redirect URL: Create your customer account-level access token
// ---------------

// When your user wishes to sign-up or connect their existing account with
// Checkr. They will click your
// [CheckrConnectLink](https://github.com/checkr/embeds-reference-integration/blob/main/client/src/components/account/CheckrConnectLink.js#L18)
// and follow the sign-up flow instructions. At the end of this flow, Checkr
// will redirect your user to this endpoint.
oauthRouter.get('/api/checkr/oauth', async (req, res) => {
  // Checkr's redirect request will contain the following query parameters:
  // - a ```code``` variable which is the OAuth authorization code generated by
  //   Checkr. This is subsequently used to acquire an access token for the
  //   user's Checkr account.
  // - a ```state``` variable which you set when creating the
  //   [CheckrConnectLink](https://github.com/checkr/embeds-reference-integration/blob/main/client/src/components/account/CheckrConnectLink.js#L18).
  //   We recommend that you set the ```state``` to a value from your product
  //   that you will associate this Checkr access token with. For example, in
  //   this scenario each customer account will have a Checkr access token associated with
  //   them. So our ```state``` value is the ID of the customer account.
  const oauthAuthorizationCode = req.query.code
  const customerAccountId = req.query.state

  // Next, you will request an OAuth access token from Checkr. This token will
  // be used for all your requests to Checkr on behalf of this user. This
  // request will require the following variables:
  // - ```CHECKR_API_URL``` which is ```https://api.checkr-staging.com``` in the staging environment and ```https://api.checkr.com``` in production
  // - ```REACT_APP_CHECKR_OAUTH_CLIENT_ID``` which is the OAuth Client ID from your [partner application](https://dashboard.checkrhq-staging.net/account/applications). This variable is prefaced with "REACT_APP" because it is also used in our UI.
  // - ```CHECKR_OAUTH_CLIENT_SECRET``` which is the OAuth Client Secret from your [partner application](https://dashboard.checkrhq-staging.net/account/applications)
  // - ```oauthAuthorizationCode``` from the request query parameters sent by Checkr
  //
  // The ```CHECKR_API_URL```, ```REACT_APP_CHECKR_OAUTH_CLIENT_ID```, and ```CHECKR_OAUTH_CLIENT_SECRET```
  // variables are taken from the app environment (via process.env) because
  // these values are different depending on whether you are using the Checkr
  // production environment or the Checkr staging environment.
  const response = await fetch(`${process.env.CHECKR_API_URL}/oauth/tokens`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: process.env.REACT_APP_CHECKR_OAUTH_CLIENT_ID,
      client_secret: process.env.CHECKR_OAUTH_CLIENT_SECRET,
      code: oauthAuthorizationCode,
    }),
    headers: {'Content-Type': 'application/json'},
  })
  const jsonBody = await parseJSON(response)
  if (!response.ok) {
    res.status(422).send({
      errors: {
        checkrApiErrors: jsonBody.errors,
      },
    })
    return
  }

  // A successful ```HTTP POST``` to
  // ```${process.env.CHECKR_API_URL}/oauth/tokens``` will have the following
  // response body:
  //
  //     {
  //       "access_token": "the customer account-level access token",
  //       "checkr_account_id": "the Checkr customer account ID",
  //     }
  //
  // Save this information along with your user's information so that you
  // can use their access token to make Checkr requests on their behalf. The
  // ```access_token``` is a secret, and we encrypt it here to emphasize that
  // it should not be stored in plaintext.
  //
  // The ```checkr_account_id``` will be used later to record that this
  // user's account has been credentialed by Checkr.

  const checkrAccount = {
    accessToken: await encrypt(jsonBody.access_token),
    id: jsonBody.checkr_account_id,
    state: 'uncredentialed',
  }
  const db = await database()
  const account = db.data.accounts.find(a => a.id === customerAccountId)
  account.checkrAccount = checkrAccount
  await db.write()

  // After saving this information, we redirect the user to a page that
  // shows them that we are waiting for Checkr to credential their account.
  // Their account must be credentialed before they can make any background
  // check requests with the stored OAuth access token.
  if (process.env.NODE_ENV === 'production') {
    res.status(200).redirect('/')
  } else {
    res.status(200).redirect('http://localhost:3000/')
  }

  // Be sure to register this endpoint as the OAuth Redirect URL in your
  // [partner application
  // configuration](https://dashboard.checkrhq-staging.net/account/applications).
  // In localhost development environments, our
  // [Developing.md](https://github.com/checkr/embeds-reference-integration/blob/main/docs/Developing.md)
  // instructions will show you how to use [ngrok](https://ngrok.com/) to
  // create a URL for this configuration.
})

// OAuth Webhook URL: Responding to Checkr Requests
// ---------------

// Checkr will send you webhook requests with information about events that
// have occured. This endpoint is required to respond to these requests. The
// most important webhook requests when connecting a user to Checkr are the
// ```account.credentialed``` and the ```token.deauthorized``` webhooks. For
// more information about Checkr's webhooks, please visit the docs
// [here](https://docs.checkr.com/partners/#section/Webhooks/Responding-to-and-securing-webhooks)
oauthRouter.post('/api/checkr/webhooks', async (req, res) => {
  // To prove the integrity of each webhook request, Checkr will create a
  // signature with the request and provide it in the ```X-Checkr-Signature```
  // header. Before processing the webhook request, it's important to check the
  // validity of the header. Refer to Checkr's [webhook
  // docs](https://docs.checkr.com/partners/#section/Webhooks/Responding-to-and-securing-webhooks)
  // for more information on how to securely validate webhook requests.
  const validCheckrSignature = (signature, payload) => {
    const expectedMac = createHmac(
      'sha256',
      process.env.CHECKR_OAUTH_CLIENT_SECRET,
    )
      .update(JSON.stringify(payload))
      .digest('hex')
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedMac))
  }
  if (!validCheckrSignature(req.headers['x-checkr-signature'], req.body)) {
    res.status(400).send({errors: ['invalid x-checkr-signature']})
    return
  }

  const db = await database()
  console.log('Handling webhook: ', req.body.type)
  // Use the webhook payload's ```type``` property to determine what to do with
  // the event.
  switch (req.body.type) {
    // #### account.credentialed webhook
    // The ```account.credentialed``` webhook is sent by Checkr to notify you
    // that the user's Checkr account has been credentialed. Only credentialed
    // accounts can order background checks.
    case 'account.credentialed':
      // The ```account.credentialed``` payload will look like this:
      //
      //     {
      //        "id": "1002d6bca6acdfcbb8442178",
      //        "object": "event",
      //        "type": "account.credentialed",
      //        "created_at": "2018-08-17T01:12:43Z",
      //        "webhook_url": "https://notify.company.com/checkr",
      //        "data": {
      //          "object": {
      //            "id": "a13f4827d8711ddc75abc56ct",
      //            "object": "account",
      //            "uri": "/v1/accounts/a13f4827d8711ddc75abc56ct",
      //            "created_at": "2018-08-17T01:10:21Z",
      //            "completed_at": "2018-08-17T01:12:26Z"
      //          }
      //        },
      //        "account_id": "61a01b40fb6dc8305c648784"
      //      }
      //
      // The ```account.credentialed``` webhook payload will have an ```account_id```
      // that you can use to identify which Checkr Account has been
      // credentialed. This ```account_id``` will match the ```checkr_account_id``` from
      // the ```${process.env.CHECKR_API_URL}/oauth/tokens``` request above.
      const checkrAccountId = req.body.account_id
      const accountToCredential = db.data.accounts.find(
        a => a.checkrAccount && a.checkrAccount.id === checkrAccountId,
      )

      // Depending on your partner application's `Pre-Credentialed accounts`
      // setting, you may receive the `account.credentialed` webhook too early
      // and you may not be in the right state to receive this webhook.
      // Whenever you are not in the right state to receive a webhook, respond
      // back with the appropriate error status (in this case a 404 Checkr
      // Account Not Found). This error status will tell Checkr to retry this
      // webhook later.
      if (!accountToCredential) {
        res.status(404).send({
          errors: [
            `cannot find account with checkr account ID ${checkrAccountId}`,
          ],
        })
        return
      }

      // Once you record that this Checkr account is credentialed, you can make
      // background check requests with the access token associated with this
      // account.
      accountToCredential.checkrAccount.state = 'credentialed'
      await db.write()

      // Successful ```HTTP Status Code 200``` responses to Checkr's webhook
      // requests will tell Checkr not to retry this webhook request.
      res.status(200).end()
      break

    // #### token.deauthorized webhook
    // The ```token.deauthorized``` webhook is sent by Checkr to notify you that
    // the user's access token is no longer valid. This can happen when your
    // user wishes to stop you from ordering background checks on your behalf.
    // <mark>All Checkr integrations are required to support this webhook.</mark>
    case 'token.deauthorized':
      // The ```token.deauthorized``` webhook payload will look like this:
      //
      //     {
      //       "id": "627d901159cacb00016149b2",
      //       "object": "event",
      //       "type": "token.deauthorized",
      //       "created_at": "2022-05-12T22:54:09Z",
      //       "data": {
      //         "object": {
      //            "access_code": "your user's access token",
      //         }
      //       },
      //       "account_id": "74376c45cf77c9567565233c"
      //     }
      //
      const checkrAccessToken = req.body.data.object.access_code

      // Use the ```data.object.access_code``` value to identify which of your
      // user's access tokens match. <span style="color:red; font-weight:
      // bold;">Do not use the account_id in the ```token.deauthorized```
      // webhook to do this. The account_id is your partner account ID, not
      // your customer's.</span>
      const accountToDisconnect = await findAccountWithMatchingToken(
        db.data.accounts,
        checkrAccessToken,
      )

      // Here, we mark the Checkr account as ```disconnected```. If your user
      // decides to reconnect your integration with their Checkr account, the
      // ```checkr_account_id``` and ```access_token``` will be regenerated.
      accountToDisconnect.checkrAccount = {state: 'disconnected'}
      await db.write()
      res.status(204).end()
      break
    default:
      console.warn(`[ WARNING ] Unhandled webhook for type: ${req.body.type}`)
  }
})

// Deauthorize an access token
// ---------------

// <mark>All Checkr integrations are required to allow their user to
// deauthorize their OAuth access token.</mark> This would disable your
// integration from ordering background checks on their behalf.
oauthRouter.post('/api/checkr/deauthorize', async (req, res) => {
  // The deauthorize request to Checkr is an ```HTTP POST``` that uses basic
  // authentication. The basic auth username is the user's access token and
  // the password is blank.
  const plaintextToken = await decrypt(req.body.encryptedToken)
  const credentials = `${Buffer.from(`${plaintextToken}:`, 'utf-8').toString(
    'base64',
  )}`
  const response = await fetch(
    `${process.env.CHECKR_API_URL}/oauth/deauthorize`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
    },
  )
  if (!response.ok) {
    const jsonBody = parseJSON(response)
    res.status(422).send({
      errors: {
        checkrApiErrors: jsonBody.errors,
      },
    })
    return
  }

  // Instead of deleting the user's access token immediately after a
  // successful deauthorization request, we wait for the subsequent
  // ```token.deauthorized``` webhook to be received. If we delete the access
  // token now, our user's Checkr account will be in a bad state to receive
  // this webhook.
  res.status(204).end()
})

export default oauthRouter
