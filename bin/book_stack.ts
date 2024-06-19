#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BookStack } from '../lib/book_stack-stack';

const app = new cdk.App();

const environments = ['devA'];

environments.forEach((environment) => {
    new BookStack(app,
        `${environment}BookStack`, {
        env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-2', awsEnvironment: environment},
    });
});
